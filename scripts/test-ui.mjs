import { chromium } from "playwright";
import { preview } from "vite";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sharp from "sharp";

await fs.mkdir("output/playwright", { recursive: true });
let server, browser, context;
try {
  server = process.env.GIFMAKER_TEST_URL
    ? null
    : await preview({ preview: { host: "127.0.0.1", port: 0 } });
  const base =
    process.env.GIFMAKER_TEST_URL ||
    `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(15000);
  const errors = [],
    external = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  await context.route("**/*", (route) => {
    if (!route.request().url().startsWith(base)) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const sheetPath = "tests/fixtures/sample-sheet.png";
  const sheet = `data:image/png;base64,${(await fs.readFile(sheetPath)).toString("base64")}`;
  const assertOutsideDismiss = async (page, trigger, overlay) => {
    for (const [x, y] of [
      [400, 30],
      [12, 300],
      [1260, 880],
    ]) {
      await trigger.click();
      await overlay.waitFor();
      assert.equal(
        await page
          .locator(".hardware-header")
          .evaluate((el) =>
            getComputedStyle(el).getPropertyValue("app-region"),
          ),
        "no-drag",
        "open dropdown leaves titlebar blank space clickable",
      );
      await page.mouse.click(x, y);
      await overlay.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector(".hardware-header"),
          ).getPropertyValue("app-region") === "drag",
      );
    }
  };
  const assertSimpleLayout = async (page, width, height = 900) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    if (
      width >= 560 &&
      (await page.locator(".app-shell").getAttribute("data-desktop-platform")) === "darwin"
    ) {
      const brand = await page.locator(".brand-section").boundingBox();
      const controls = await page.locator(".header-controls").boundingBox();
      assert.ok(brand.x >= 104, "title stays clear of native macOS window buttons");
      assert.ok(brand.x + brand.width <= controls.x, "title and header controls do not overlap");
      assert.ok(controls.x + controls.width <= width, "header controls fit the window");
    }
    assert.ok(
      await page.locator(".header-controls button:visible").evaluateAll((buttons) =>
        buttons.every((button) => {
          const box = button.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth + 1;
        }),
      ),
      "connection, project and export controls fit even the narrowest header",
    );
    const exportAction=page.locator('.export-action');
    if (await exportAction.count()) {
      assert.ok(await exportAction.locator('span').last().isVisible(), 'export format stays visible on narrow screens');
      const main=await exportAction.boundingBox(),arrow=await page.locator('.export-format-trigger').boundingBox();
      assert.ok(Math.abs(main.x+main.width-arrow.x)<=1&&main.y===arrow.y,'split button stays joined at every width');
    }
    const input = await page
      .getByRole("region", { name: "动画输入" })
      .boundingBox();
    const source = await page
      .getByRole("region", { name: "图片上传展示区", exact: true })
      .locator(".preview-panel")
      .boundingBox();
    const canvas = await page
      .getByRole("region", { name: "生成结果预览", exact: true })
      .locator(".preview-panel")
      .boundingBox();
    assert.ok(source.x + source.width < canvas.x, "source stays left of the result");
    assert.ok(Math.abs(source.y - canvas.y) <= 1, "both preview panes align at the top");
    assert.ok(Math.abs(source.height - canvas.height) <= 1, "preview panes have equal height");
    assert.ok(Math.abs(source.width - canvas.width) <= 1, "preview panes have equal width");
    assert.ok(Math.abs(source.width - source.height) <= 1, "source preview stays square");
    assert.ok(Math.abs(canvas.width - canvas.height) <= 1, "result preview stays square");
    assert.ok(
      await page.locator(".preview-image").evaluateAll((images) =>
        images.every((image) => {
          const style = getComputedStyle(image);
          const box = image.getBoundingClientRect();
          const surface = image.closest(".preview-panel").getBoundingClientRect();
          return style.objectFit === "cover" &&
            Math.abs(box.left - surface.left) <= 1 && Math.abs(box.right - surface.right) <= 1 &&
            Math.abs(box.top - surface.top) <= 1 && Math.abs(box.bottom - surface.bottom) <= 1;
        }),
      ),
      "images fill the square panes without padding or stretching",
    );
    assert.ok(source.width > 100 && canvas.width > 100, "both panes remain usable in small windows");
    assert.ok(
      source.x >= 0 && canvas.x + canvas.width <= width &&
      source.y >= 68 && canvas.y + canvas.height <= input.y,
      "both preview panes fit above the composer: " +
        JSON.stringify({ width, height, source, canvas, input }),
    );
    assert.ok(
      await page.locator(".preview-window button:visible").evaluateAll((buttons) =>
        buttons.every((button) => {
          const box = button.getBoundingClientRect();
          const pane = button.closest(".preview-window").getBoundingClientRect();
          return box.left >= pane.left - 1 && box.right <= pane.right + 1 &&
            box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1;
        }),
      ),
      "upload, playback and export controls stay inside their own pane",
    );
    assert.ok(
      input.x >= 0 &&
        input.x + input.width <= width &&
        input.y + input.height <= height,
      "composer fits the viewport",
    );
    assert.ok(
      await page.evaluate(() => {
        const workspace = document.querySelector(".workspace");
        return (
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1 &&
          workspace.scrollHeight <= workspace.clientHeight + 1
        );
      }),
      "workspace has no horizontal or vertical overflow",
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: /帧缩略图|一次生成的动画数量|查看生图提示词|提示词预设/,
        })
        .count(),
      0,
    );
    assert.equal(await page.getByText("帧缩略图", { exact: true }).count(), 0);
  };

  const page = await context.newPage();
  await page.addInitScript(() => { window.fox24 = { title: async () => ({ title: '红绿灯闪烁' }) }; });
  await page.goto(base);
  await page.getByRole("button", { name: "上传参考图" }).waitFor();
  assert.equal(await page.title(), "GifHop");
  assert.equal(
    await page
      .getByRole("button", { name: "生成动画", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "打开工程", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".connection-banner").count(), 0, "browser preview is not a failed native connection");
  assert.equal(await page.getByRole("button", { name: /连接 Codex|本机 Codex/ }).count(), 0);
  assert.equal(await page.getByRole("dialog", { name: "Codex 连接设置" }).count(), 0);
  await assertSimpleLayout(page, 1280);
  assert.equal(
    await page.getByRole("button", { name: "导出 GIF", exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("button", { name: "导出 GIF", exact: true }).isDisabled(), true);
  await page.screenshot({ path: "output/playwright/simple-empty.png" });
  const keyboardChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传参考图", exact: true }).focus();
  await page.keyboard.press("Enter");
  await (await keyboardChooser).setFiles(sheetPath);
  await page.getByRole("img", { name: "动画参考图" }).waitFor();
  assert.equal(
    await page.getByRole("img", { name: "动画预览画面" }).count(),
    0,
  );
  await page.screenshot({ path: "output/playwright/dual-reference.png" });
  const cornerColors = [
    [230, 76, 60], [46, 204, 113], [52, 152, 219], [241, 196, 15],
  ];
  for (const [width, height] of [[320, 640], [640, 320]]) {
    const corners = [[0, 0], [width - 32, 0], [0, height - 32], [width - 32, height - 32]];
    const overlays = await Promise.all(cornerColors.map(async ([r, g, b], index) => ({
      input: await sharp({ create: { width: 32, height: 32, channels: 3, background: { r, g, b } } }).png().toBuffer(),
      left: corners[index][0], top: corners[index][1],
    })));
    const buffer = await sharp({ create: { width, height, channels: 3, background: "#eeeeee" } })
      .composite(overlays).png().toBuffer();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "corner-markers.png", mimeType: "image/png", buffer });
    await page.waitForFunction(([width, height]) => {
      const image = document.querySelector('img[alt="动画参考图"]');
      return image?.naturalWidth === width && image.naturalHeight === height;
    }, [width, height]);
    await assertSimpleLayout(page, 1280);
    const pixels = await sharp(await page.locator(".reference-panel").screenshot())
      .removeAlpha().raw().toBuffer();
    for (const color of cornerColors) {
      let count = 0;
      for (let pixel = 0; pixel < pixels.length; pixel += 3) {
        if (color.every((channel, index) => pixels[pixel + index] === channel)) count++;
      }
      assert.equal(count, 0, `${width}×${height} reference clips corner markers outside the centered square`);
    }
  }
  await page.locator(".reference-panel").hover();
  await page.getByRole("button", { name: "移除图片" }).click();
  await page.getByRole("button", { name: "上传参考图", exact: true }).waitFor();
  const transfer = await page.evaluateHandle((sheet) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [
          Uint8Array.from(atob(sheet.split(",")[1]), (char) =>
            char.charCodeAt(0),
          ),
        ],
        "reference.png",
        { type: "image/png" },
      ),
    );
    return data;
  }, sheet);
  await page
    .getByRole("region", { name: "图片上传展示区" })
    .locator(".reference-panel")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await page.getByRole("img", { name: "动画参考图" }).waitFor();
  await page.locator(".reference-panel").hover();
  await page.getByRole("button", { name: "移除图片" }).click();
  await page.evaluate(
    (transfer) =>
      document.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }),
      ),
    transfer,
  );
  await page.getByRole("img", { name: "动画参考图" }).waitFor();
  await page.locator(".reference-panel").hover();
  await page.getByRole("button", { name: "移除图片" }).click();
  await transfer.dispose();
  assert.equal(await page.getByRole("button", { name: "导入帧图", exact: true }).count(), 0);
  assert.equal(await page.locator('input[type="file"]').count(), 1, "only reference upload remains");
  // Seed an existing recovery fixture; animation/export checks do not depend on manual imports.
  await page.evaluate(async sheet => {
    const { desktop } = await import('/src/desktop-client.js');
    await desktop.writeRecovery({ format: 'fox24', version: 1, prompt: '已有动画', referenceImage: null, slots: [{ sheet, offsets: [] }] });
  }, sheet);
  await page.reload();
  await page.getByRole("button", { name: "恢复工程", exact: true }).click();
  await page.getByRole("img", { name: "动画预览画面", exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-notices, .product-notice").count(), 0, "recovery has no title-bar banner");
  const previewImage = page.getByRole("img", {
    name: "动画预览画面",
    exact: true,
  });
  await previewImage.waitFor();
  await page.locator(".result-panel").hover();
  await page.getByRole("button", { name: "暂停播放" }).click();
  const paused = await previewImage.getAttribute("src");
  await page.waitForTimeout(180);
  assert.ok(
    (await previewImage.getAttribute("src")) === paused,
    "pause keeps the preview still",
  );
  const box = await previewImage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 20,
    { steps: 4 },
  );
  await page.mouse.up();
  await previewImage.click({ button: "right", force: true });
  assert.ok(
    (await previewImage.getAttribute("src")) === paused,
    "preview no longer edits positions",
  );
  await page.locator(".result-panel").hover();
  await page.getByRole("button", { name: "播放动画" }).click();
  await page.waitForFunction(
    (src) => document.querySelector(".preview-image").src !== src,
    paused,
  );
  const format = page.getByRole("button", { name: /选择导出格式/ });
  assert.equal(await page.locator(".hardware-header").getByRole("button", { name: "导出 GIF", exact: true }).count(), 1, "export lives in the title bar");
  const exportButton = page.getByRole('button', {name:'导出 GIF',exact:true});
  const actionBox = await exportButton.boundingBox(), arrowBox = await format.boundingBox();
  assert.ok(Math.abs(actionBox.x + actionBox.width - arrowBox.x) <= 1 && actionBox.y === arrowBox.y && actionBox.height === arrowBox.height, 'export segments form one adjacent button');
  let exportDownloads = 0;page.on('download', () => exportDownloads++);
  await format.click();
  await page.getByRole('menuitemradio', {name:'GIF',exact:true}).waitFor();
  assert.equal(await page.getByRole('menuitemradio', {name:'GIF',exact:true}).getAttribute('aria-checked'),'true');
  await page.getByRole('menuitemradio', {name:'WebP',exact:true}).click();
  await page.getByRole('button', {name:'导出 WebP',exact:true}).waitFor();
  assert.equal(exportDownloads,0,'choosing a format does not export');
  const webpDownload=page.waitForEvent('download');
  await page.getByRole('button', {name:'导出 WebP',exact:true}).click();
  const webpFile=await webpDownload;
  assert.match(webpFile.suggestedFilename(),/\.webp$/);
  assert.equal((await sharp(await webpFile.path(), {animated:true}).metadata()).pages,24);
  await format.focus();await page.keyboard.press('Space');
  await page.getByRole('menuitemradio', {name:'WebP',exact:true}).waitFor();
  await page.keyboard.press('End');await page.keyboard.press('Enter');
  await page.getByRole('button', {name:'导出视频',exact:true}).waitFor();
  assert.equal(exportDownloads,1,'keyboard format choice does not export');
  await format.focus();
  await page.keyboard.press("Space");
  await page.getByRole("menuitemradio", { name: "GIF", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 GIF", exact: true }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^红绿灯闪烁-\d+px\.gif$/);
  const metadata = await sharp(await file.path(), {
    animated: true,
  }).metadata();
  assert.equal(metadata.pages, 24);
  assert.equal(metadata.width, 320);
  await page.close();
  console.log(
    "PASS offline recovery, animation playback/pause, non-editable preview, real 24-frame GIF export",
  );

  const app = await context.newPage();
  await app.addInitScript(
    ({ sheet }) => {
      let progress;
      const pending = new Map();
      window.__calls = [];
      window.__statusCalls = 0;
      window.__mode = "success";
      localStorage.setItem("frame24-settings", JSON.stringify({ codexModel: "gpt-6-astra", exportFormat: "webp" }));
      window.fox24 = {
        platform: "darwin",
        generateReference: async () => ({ image: sheet }),
        status: async () => {
          window.__statusCalls++;
          if (window.__holdStatus) await new Promise(resolve => { window.__releaseStatus = resolve; });
          if (window.__failStatus) throw new Error("检测暂不可用");
          return ({
          ready: window.__ready !== false,
          installed: true, compatible: true, loggedIn: true,
          automaticModel: window.__automaticModel ?? "gpt-6-luna",
          message: window.__connectionMessage || "Codex 已连接",
          version: "codex-cli 0.164.0",
          defaultModel: window.__defaultModel ?? "gpt-6.1-sol",
          models: window.__models ?? [
            { id: "gpt-6.1-sol", isDefault: true },
            { id: "gpt-6-astra", isDefault: false },
            { id: "gpt-6.1-terra", isDefault: false },
            { id: "hidden-model", isDefault: false },
          ],
          modelListError: window.__modelListError || "",
        }); },
        onProgress: (fn) => {
          progress = fn;
          return () => {};
        },
        readRecovery: async () => window.__legacyRecovery || null,
        writeRecovery: async (project) => {
          window.__recovery = project;
        },
        saveFile: async (value) => {
          window.__file = { name: value.name, length: value.bytes.length };
          return true;
        },
        ask: async (input) => {
          window.__calls.push({ ...input, kind: "ask" });
          return { text: "小狐狸挥手并循环。" };
        },
        cancel: async (id) => {
          pending.get(id)?.reject(new Error("已取消。"));
          pending.delete(id);
        },
        generate: async (input) => {
          window.__calls.push({ ...input, kind: "generate" });
          progress?.({ id: input.id, stage: "generating" });
          if (window.__mode === "wait")
            return new Promise((resolve, reject) =>
              pending.set(input.id, { resolve, reject }),
            );
          if (window.__mode === "fail") throw new Error("Codex 生图暂不可用");
          return { image: sheet, title: '红绿灯闪烁' };
        },
      };
    },
    { sheet },
  );
  await app.goto(base);
  await app.waitForFunction(() => window.__statusCalls > 0);
  assert.equal(await app.locator(".connection-banner").count(), 0, "connected state stays silent");
  assert.equal(await app.getByText('Codex 已连接', {exact:true}).count(), 0);
  assert.equal(await app.getByRole('dialog', {name:'Codex 连接设置'}).count(),0,'connection status cannot open a panel');
  const statusCalls = await app.evaluate(() => window.__statusCalls);
  await app.evaluate(() => {
    window.__holdStatus = true;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await app.evaluate(() => window.__statusCalls), statusCalls + 1, 'overlapping visibility/focus checks share one request');
  await app.evaluate(() => { window.__holdStatus = false; window.__releaseStatus(); });
  await app.evaluate(() => new Promise(requestAnimationFrame));
  await app.evaluate(() => { window.__failStatus = true; window.dispatchEvent(new Event('focus')); });
  await app.getByRole('alert', {name:'Codex 未连接',exact:true}).waitFor();
  assert.ok((await app.locator('.connection-banner').textContent()).includes('检测暂不可用'));
  await app.evaluate(() => { window.__failStatus = false; window.dispatchEvent(new Event('focus')); });
  await app.locator('.connection-banner').waitFor({state:'hidden'});
  const prompt = app.getByRole("textbox", { name: "动作描述", exact: true });
  assert.equal(await app.getByRole('button',{name:'AI 润色提示词',exact:true}).isDisabled(),true);
  const emptyPromptHeight = (await prompt.boundingBox()).height;
  const lineHeight = await prompt.evaluate((el) =>
    parseFloat(getComputedStyle(el).lineHeight),
  );
  assert.ok(
    Math.abs(emptyPromptHeight - lineHeight) <= 1,
    "empty prompt occupies one line",
  );
  await prompt.fill("小狐狸挥手");
  assert.ok(
    Math.abs((await prompt.boundingBox()).height - emptyPromptHeight) <= 1,
    "short prompt stays compact",
  );
  await prompt.press("End");
  await app.keyboard.press("Shift+Enter");
  await app.keyboard.insertText("眨眼后回到原位");
  assert.ok(
    (await prompt.boundingBox()).height >= lineHeight * 2 - 1,
    "manual newlines expand the prompt",
  );
  await prompt.fill(
    "小狐狸撑着雨伞走过街道，收起雨伞后眨眼微笑，再回到起始姿势。".repeat(50),
  );
  assert.ok(
    (await prompt.boundingBox()).height > emptyPromptHeight * 2,
    "long prompts expand automatically",
  );
  assert.ok(
    await prompt.evaluate(
      (el) =>
        el.clientHeight <= parseFloat(getComputedStyle(el).maxHeight) + 1 &&
        el.scrollHeight > el.clientHeight,
    ),
    "very long prompts stop at the height limit and stay editable",
  );
  await assertSimpleLayout(app, 960, 700);
  await app.screenshot({ path: "output/playwright/prompt-expanded.png" });
  await prompt.fill("");
  assert.ok(
    Math.abs((await prompt.boundingBox()).height - emptyPromptHeight) <= 1,
    "clearing shrinks the prompt back to one line",
  );
  await assertSimpleLayout(app, 320, 568);
  assert.ok(
    Math.abs((await prompt.boundingBox()).height - lineHeight) <= 1,
    "empty prompt stays single-line on narrow screens",
  );
  await app.screenshot({ path: "output/playwright/prompt-compact-mobile.png" });
  await app.setViewportSize({ width: 1280, height: 900 });
  await prompt.fill("小狐狸挥手");
  await prompt.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  assert.equal(await app.evaluate(() => window.__calls.length), 0);
  await app.getByRole("button", { name: "AI 润色提示词" }).click();
  await app.waitForFunction(
    () =>
      document.querySelector(".prompt-textarea").value === "小狐狸挥手并循环。",
  );
  assert.equal(
    await app.evaluate(() => window.__calls.at(-1).model),
    undefined,
    "polish delegates automatic model routing to the backend",
  );
  await app.getByRole("button", { name: "生成动画", exact: true }).click();
  await app.getByRole("img", { name: "动画预览画面" }).waitFor();
  assert.equal(
    await app.evaluate(
      () => window.__calls.filter((call) => call.kind === "generate").length,
    ),
    1,
  );
  assert.equal(
    await app.evaluate(
      () => window.__calls.find((call) => call.kind === "generate").model,
    ),
    undefined,
    "generation never forwards the old expensive saved model",
  );
  await app.waitForFunction(() => !!window.__recovery?.slots?.[0]?.sheet);
  assert.equal(await app.evaluate(() => window.__recovery.slots.length), 1);
  assert.deepEqual(
    await app.evaluate(() => window.__recovery.slots[0].offsets),
    [],
  );
  await app.locator(".result-panel").hover();
  await app.getByRole("button", { name: "暂停播放" }).click();
  const previous = await app
    .getByRole("img", { name: "动画预览画面" })
    .getAttribute("src");
  await app.evaluate(() => {
    window.__mode = "wait";
  });
  await app.getByRole("button", { name: "生成动画", exact: true }).click();
  assert.ok(await app.locator('.export-controls button').evaluateAll(buttons => buttons.length === 2 && buttons.every(button => button.disabled)), 'generation locks both export segments');
  const beforeBusyCheck = await app.evaluate(() => window.__statusCalls);
  await app.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await app.evaluate(() => window.__statusCalls),beforeBusyCheck,'status rechecks do not run during generation');
  const cancelGeneration = app.getByRole("button", { name: "取消生成", exact: true });
  assert.equal(await cancelGeneration.isEnabled(), true, "the primary generation button stays actionable while generating");
  assert.equal(await cancelGeneration.evaluate(button => button.classList.contains('generate-button')), true);
  assert.equal(await app.getByRole("button", { name: "取消任务", exact: true }).count(), 0, "generation uses one primary cancel action");
  await cancelGeneration.click();
  await app.getByRole("alert").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await app.getByRole("button", { name: "生成动画", exact: true }).isEnabled(), true);
  assert.ok(
    (await app
      .getByRole("img", { name: "动画预览画面" })
      .getAttribute("src")) === previous,
    "cancel keeps the last result",
  );
  await app.evaluate(() => {
    window.__mode = "fail";
  });
  await app.getByRole("button", { name: "生成动画", exact: true }).click();
  await app
    .getByRole("alert")
    .filter({ hasText: "Codex 生图暂不可用" })
    .waitFor();
  assert.ok(
    (await app
      .getByRole("img", { name: "动画预览画面" })
      .getAttribute("src")) === previous,
    "failed generation keeps the last result",
  );
  await app.evaluate(() => {
    window.__mode = "success";
  });

  const beforeUploadDraft=await prompt.inputValue();
  const beforeUploadCalls=await app.evaluate(()=>window.__calls.length);
  const refChooser = app.waitForEvent("filechooser");
  await app.locator(".reference-panel").hover();
  await app.getByRole("button", { name: "更换图片", exact: true }).click();
  await (await refChooser).setFiles(sheetPath);
  await app.getByRole("img", { name: "动画参考图" }).waitFor();
  assert.ok(await app.getByRole("img", { name: "动画预览画面" }).isVisible(), "upload preserves the visible result");
  assert.equal(await prompt.inputValue(),beforeUploadDraft,'uploading an image never replaces the prompt');
  assert.equal(await app.evaluate(()=>window.__calls.length),beforeUploadCalls,'uploading an image makes no AI request');
  assert.equal(await app.getByRole('button',{name:/生成动画提示词|切换动画提示词|生成提示词|换一个/}).count(),0);
  assert.equal(await app.evaluate(async()=> 'suggest' in (await import('/src/desktop-client.js')).desktop),false,'suggestions are absent from the client bridge');

  assert.ok(await app.getByRole("img", { name: "动画参考图" }).isVisible(), "source and result are visible together");
  assert.equal(await app.getByRole("button", { name: /查看动画|查看参考图/ }).count(), 0, "dual panes need no view switching");
  await prompt.focus();
  await app.mouse.move(4, 250);
  assert.equal(await app.locator(".reference-actions").evaluate((el) => getComputedStyle(el).opacity), "0", "reference controls hide away from the image");
  assert.equal(await app.locator(".preview-playback").evaluate((el) => getComputedStyle(el).opacity), "0", "playback hides away from the image");
  await app.locator(".reference-panel").hover();
  assert.equal(await app.locator(".reference-actions").evaluate((el) => getComputedStyle(el).opacity), "1", "hover reveals source controls inside the image");
  await app.mouse.move(4, 250);
  await app.locator(".result-panel").hover();
  assert.equal(await app.locator(".preview-playback").evaluate((el) => getComputedStyle(el).opacity), "1", "hover reveals playback inside the result");
  const playbackBox = await app.locator(".preview-playback").boundingBox();
  const resultBox = await app.locator(".result-panel").boundingBox();
  assert.ok(Math.abs(playbackBox.x + playbackBox.width / 2 - resultBox.x - resultBox.width / 2) < 1 &&
    Math.abs(playbackBox.y + playbackBox.height / 2 - resultBox.y - resultBox.height / 2) < 1, "playback sits at the center of the result");
  await app.mouse.move(4, 250);
  await app.locator(".export-action").focus();
  await app.keyboard.press("Tab");
  assert.ok(await app.locator(".export-format-trigger").evaluate(el => document.activeElement === el), "Tab reaches the export arrow after its main action");
  await app.keyboard.press("Tab");
  assert.ok(await app.locator(".reference-crop").evaluate((el) => document.activeElement === el), "Tab reaches the crop control");
  await app.keyboard.press("Tab");
  assert.ok(await app.locator(".reference-replace").evaluate((el) => document.activeElement === el), "Tab reaches hidden reference actions");
  assert.equal(await app.locator(".reference-actions").evaluate((el) => getComputedStyle(el).opacity), "1", "keyboard focus reveals reference actions");
  const resultFocus = [];
  for (let step=0;step<7;step++) {
    await app.keyboard.press('Tab');
    resultFocus.push(await app.evaluate(() => document.activeElement?.getAttribute('aria-label')));
    if (resultFocus.at(-1) === '暂停播放' || resultFocus.at(-1) === '播放动画') break;
  }
  assert.ok(resultFocus.includes('删除当前结果'), 'keyboard navigation reaches direct result deletion');
  assert.ok(resultFocus.at(-1) === '暂停播放' || resultFocus.at(-1) === '播放动画', 'Tab reaches playback');
  assert.equal(await app.locator(".preview-playback").evaluate((el) => getComputedStyle(el).opacity), "1", "keyboard focus reveals playback");
  const playbackLabel = await app.locator(".preview-playback").getAttribute("aria-label");
  await app.keyboard.press("Space");
  assert.notEqual(await app.locator(".preview-playback").getAttribute("aria-label"), playbackLabel, "Space toggles playback");
  await app.keyboard.press("Space");
  await prompt.focus();
  for (let click = 0; click < 2; click++) {
    await app.locator(".result-panel").hover();
    await app.locator(".preview-playback").click();
    await app.mouse.move(4, 250);
    assert.equal(await app.locator(".preview-playback").evaluate((el) => getComputedStyle(el).opacity), "0", "mouse playback controls hide on leave even after clicking");
  }
  await prompt.focus();
  const changeReference = app.waitForEvent("filechooser");
  await app.locator(".reference-panel").hover();
  await app.getByRole("button", { name: "更换图片", exact: true }).click();
  await (await changeReference).setFiles("public/assets/gifmaker-icon/web/icon-192.png");
  const replacedReference = `data:image/png;base64,${(await fs.readFile("public/assets/gifmaker-icon/web/icon-192.png")).toString("base64")}`;
  await app.waitForFunction((dataUrl) => document.querySelector('img[alt="动画参考图"]').src === dataUrl, replacedReference);
  assert.ok(await app.getByRole("img", { name: "动画预览画面" }).isVisible(), "replacing the source preserves the result");
  await app.screenshot({ path: "output/playwright/dual-preview-populated.png" });
  await app.locator(".reference-panel").hover();
  await app.getByRole("button", { name: "移除图片", exact: true }).click();
  assert.ok(await app.getByRole("img", { name: "动画预览画面" }).isVisible());
  await prompt.fill("");
  const replacement = app.waitForEvent("filechooser");
  await app.getByRole("button", { name: "上传参考图", exact: true }).click();
  await (await replacement).setFiles(sheetPath);
  await app.getByRole("img", { name: "动画参考图" }).waitFor();
  assert.equal(await prompt.inputValue(), "", "reference-only input remains empty");
  assert.equal(await app.getByRole("button",{name:"AI 润色提示词",exact:true}).isDisabled(),true,"empty text cannot start prompt generation through polishing");
  assert.equal(await app.getByRole("button", { name: /采用/ }).count(), 0);
  await app.getByRole("button", { name: "生成动画", exact: true }).click();
  await app.waitForFunction(
    () =>
      window.__calls.filter((call) => call.kind === "generate").length === 4 &&
      !document.querySelector('[aria-busy="true"]'),
  );
  assert.equal(
    await prompt.inputValue(),
    "",
    "image-only generation keeps the composer empty",
  );
  assert.equal(await app.evaluate(()=>window.__calls.at(-1).prompt),'','the bridge preserves blank input for autonomous reference generation');
  assert.ok(
    await app.evaluate(() =>
      window.__calls.at(-1).referenceImage?.startsWith("data:image/png"),
    ),
  );
  assert.ok(await app.getByRole("img", { name: "动画参考图" }).isVisible(), "generation keeps the original visible in the left pane");
  assert.ok(await app.getByRole("img", { name: "动画预览画面" }).isVisible(), "generation displays the animation in the right pane");
  await app.waitForFunction(() => !!window.__recovery?.slots?.[0]?.sheet);

  await assertOutsideDismiss(
    app,
    app.getByRole("button", { name: /选择导出格式/ }),
    app.getByRole("menu", { name: "导出格式" }),
  );
  assert.equal(await app.evaluate(() => JSON.parse(localStorage.getItem("frame24-settings")).codexModel), undefined,
    "old expensive preferences are removed from settings");
  await app.screenshot({ path: "output/playwright/automatic-connection.png" });
  await app.evaluate(() => {
    window.__ready = false;
    window.__automaticModel = "";
    window.__connectionMessage = "当前账号未提供可用的低成本模型，请检查 Codex 账号权限。";
    window.dispatchEvent(new Event('focus'));
  });
  await app.getByRole('alert',{name:'Codex 未连接',exact:true}).waitFor();
  assert.ok((await app.locator('.connection-banner').textContent()).includes('当前账号未提供可用的低成本模型，请检查 Codex 账号权限。'));
  assert.equal(await app.getByRole("button", { name: "生成动画", exact: true }).isDisabled(), true);
  await app.evaluate(() => {
    window.__ready = true; window.__automaticModel = "gpt-6-luna"; window.__connectionMessage = "";
    window.dispatchEvent(new Event('focus'));
  });
  await app.locator('.connection-banner').waitFor({state:'hidden'});
  await prompt.fill(
    "固定镜头，小狐狸挥手、眨眼，再回到起始姿势，无缝循环。".repeat(25),
  );
  for (const [width, height] of [
    [1280, 900],
    [960, 700],
    [701, 700],
    [700, 700],
    [620, 700],
    [560, 700],
    [1200, 600],
    [390, 844],
    [320, 568],
  ]) {
    await assertSimpleLayout(app, width, height);
    const generateBox = await app
      .getByRole("button", { name: "生成动画", exact: true })
      .boundingBox();
    assert.ok(
      generateBox.y >= 0 && generateBox.y + generateBox.height <= height,
      "generate remains visible",
    );
    await app.screenshot({
      path: `output/playwright/simple-workspace-${width}.png`,
    });
  }
  // Legacy projects keep the first saved clip and its read-only offsets; earlier version records are gone.
  await app.addInitScript((sheet) => {
    window.__legacyRecovery = {
      format: "fox24",
      version: 1,
      prompt: "旧工程",
      referenceImage: null,
      slots: [
        { sheet, offsets: [{ dx: 8, dy: -5 }] },
        { sheet, offsets: [] },
      ],
    };
  }, sheet);
  await app.reload();
  await app.getByRole("button", { name: "恢复工程", exact: true }).click();
  await app.getByRole("img", { name: "动画预览画面", exact: true }).waitFor();
  assert.equal(await app.locator(".workspace-notices, .product-notice").count(), 0, "recovery has no title-bar banner");
  await app.waitForFunction(() => !!window.__recovery?.slots?.[0]?.sheet);
  assert.equal(await app.evaluate(() => window.__recovery.slots.length), 1);
  assert.deepEqual(await app.evaluate(() => window.__recovery.slots[0].offsets), [{ dx: 8, dy: -5 }]);
  assert.equal(await app.evaluate(() => window.__recovery.historyIds), undefined, 'version history is not carried in drafts');
  assert.equal(await app.getByRole('button', { name: '下一个版本', exact: true }).count(), 0);
  assert.equal(await app.getByRole('button', { name: '上一个版本', exact: true }).count(), 0);

  const recovery = await context.newPage();
  await recovery.addInitScript(() => {
    window.fox24 = {
      platform: "darwin",
      status: async () => ({
        ready: true,
        defaultModel: "gpt-6.1-sol",
        models: [
          { id: "gpt-6.1-sol", isDefault: true },
          { id: "gpt-6.1-terra", isDefault: false },
        ],
      }),
      onProgress: () => () => {},
      readRecovery: async () => ({
        format: "fox24",
        version: 1,
        prompt: "上次未完成的工程",
        slots: [{ sheet: null, offsets: [] }],
      }),
      writeRecovery: async () => {},
    };
  });
  await recovery.goto(base);
  await recovery.getByText("找到上次的工程", { exact: true }).waitFor();
  assert.equal(await recovery.locator('.connection-banner').count(),0);
  await recovery.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await recovery.getByRole('dialog',{name:'Codex 连接设置'}).count(),0);
  assert.ok(
    await recovery.getByText("找到上次的工程", { exact: true }).isVisible(),
  );
  assert.ok(
    await recovery
      .getByRole("textbox", { name: "动作描述", exact: true })
      .isDisabled(),
  );
  await recovery.close();
  // A compact checkpoint can contain a material without a prompt or reference.
  const materialRecovery = await context.newPage();
  await materialRecovery.addInitScript(sheet => {
    window.fox24 = {
      status: async () => ({ ready: false, installed: false }),
      readRecovery: async () => ({
        format: "fox24", version: 2,
        prompt: "", referenceImage: null, slots: [{ sheet, offsets: [] }],
      }),
    };
  }, sheet);
  await materialRecovery.goto(base);
  await materialRecovery.getByRole("button", { name: "恢复工程", exact: true }).click();
  await materialRecovery.getByRole("img", { name: "动画预览画面", exact: true }).waitFor();
  assert.equal(await materialRecovery.getByRole("textbox", { name: "动作描述", exact: true }).inputValue(), "");
  await materialRecovery.close();
  const devRecovery = await context.newPage();
  await devRecovery.addInitScript(({ sheet }) => {
    window.__checkpointWrites = [];
    window.fox24 = {
      platform: "darwin",
      autoRestoreRecovery: true,
      status: async () => ({ ready: false, installed: false }),
      onProgress: () => () => {},
      readRecovery: async () => ({
        format: "fox24", version: 1, prompt: "重启前的动画创意",
        referenceImage: sheet, slots: [{ sheet, offsets: [] }],
      }),
      writeRecovery: async (project) => {
        if (window.__checkpointFailure) throw new Error("磁盘暂不可写");
        window.__checkpointWrites.push(project);
      },
      onBeforeDevRestart: callback => {
        window.__checkpoint = callback;
        return () => { window.__checkpoint = null; };
      },
    };
  }, { sheet });
  await devRecovery.goto(base);
  const restoredPrompt = devRecovery.getByRole("textbox", { name: "动作描述", exact: true });
  await devRecovery.waitForFunction(() => document.querySelector('textarea')?.value === "重启前的动画创意");
  await devRecovery.getByRole("img", { name: "动画参考图", exact: true }).waitFor();
  await devRecovery.getByRole("img", { name: "动画预览画面", exact: true }).waitFor();
  assert.equal(await devRecovery.getByRole("button", { name: "恢复工程", exact: true }).count(), 0);
  assert.equal(await devRecovery.getByText("工程已恢复", { exact: true }).count(), 0);
  await restoredPrompt.fill("刚输入、还没等到自动保存的最新创意");
  await devRecovery.evaluate(() => window.__checkpoint());
  const checkpoint = await devRecovery.evaluate(() => window.__checkpointWrites.at(-1));
  assert.equal(checkpoint.prompt, "刚输入、还没等到自动保存的最新创意");
  assert.equal(checkpoint.referenceImage, sheet);
  assert.equal(checkpoint.slots[0].sheet, sheet, "restart checkpoint keeps the current result");
  await devRecovery.evaluate(() => { window.__checkpointFailure = true; });
  await assert.rejects(devRecovery.evaluate(() => window.__checkpoint()), /磁盘暂不可写/);
  await devRecovery.getByText("自动保存失败：磁盘暂不可写", { exact: true }).waitFor();
  await devRecovery.close();
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base);
  await mobile.waitForFunction(() =>
    !!document.querySelector('.prompt-textarea') &&
    (!document.querySelector('.prompt-textarea').disabled ||
      [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '放弃恢复')),
  );
  if (await mobile.getByRole("button", { name: "放弃恢复", exact: true }).isVisible())
    await mobile.getByRole("button", { name: "放弃恢复", exact: true }).click();
  await assertSimpleLayout(mobile, 390, 844);
  await mobile
    .getByRole("textbox", { name: "动作描述", exact: true })
    .fill("雨后的小狐狸收起雨伞，抖落水珠，再眨眼微笑。");
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.equal(await mobile.getByRole("button", { name: "导入帧图", exact: true }).count(), 0);
  assert.equal(await mobile.locator('input[type="file"]').count(), 1);
  assert.equal(await mobile.getByRole("button", { name: "打开工程", exact: true }).count(), 0);
  assert.equal(await mobile.getByRole("button", { name: "保存工程", exact: true }).count(), 0);
  assert.equal(await mobile.evaluate(async () => {
    const { desktop } = await import('/src/desktop-client.js');
    return 'saveProject' in desktop || 'openProject' in desktop;
  }), false, "manual project operations are absent from the client bridge");
  await mobile.screenshot({
    path: "output/playwright/simple-mobile.png",
    fullPage: true,
  });
  await mobile.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS simple UI: single generation, IME, image-only input, automatic recovery without manual project actions, cancellation/failure preserving results, legacy project compatibility, keyboard, automatic model routing with no manual picker or saved expensive preference, auto-expanding single-line prompt, export dropdown outside-click dismissal and non-interactive connection status, side-by-side source/result panes, source replacement/removal preserving the result, no-scroll desktop and mobile layout, no external requests",
  );
} finally {
  await context?.close();
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.httpServer.close(resolve));
    assert.equal(server.httpServer.listening, false);
  }
}
