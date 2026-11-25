import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from 'react-dom';
import {
  Button,
  Label,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import {
  Download,
  ImagePlus,
  Pause,
  Play,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import "./styles.css";
import { encodeGif, encodeAnimatedWebp } from "./exporters";
import { desktop } from "./desktop-client";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExportButton } from "./components/ExportButton";
import { PreviewImage } from "./components/PreviewImage";
import { ReferenceImage } from './components/ReferenceImage';
import { restorePromptInput } from "./prompt-input";
import { squareReferenceImage } from './reference-image';
import { normalizeReferenceCrop } from '../reference-crop.mjs';
import { animationFilename, normalizeAnimationTitle, normalizeReferenceTitle } from '../animation-title.mjs';

const FRAME_COUNT = 24;
const PREVIEW_SIZE = 360;
const EXPORT_VIDEO_BG = "#141312";
const SETTINGS_STORAGE_KEY = "frame24-settings";
const emptyClip = () => ({ sheetSrc: null, frames: [], legacyOffsets: [] });

function readStoredSetting(key, fallback) {
  try {
    const value = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}",
    )[key];
    return typeof value === typeof fallback &&
      (typeof value !== "string" || value.length <= 4000)
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片损坏或格式不受支持。"));
    image.src = src;
  });
}

// Old project offsets are read only, so previously saved animations keep their appearance.
async function decodeSheet(src, legacyOffsets = [], size = PREVIEW_SIZE) {
  const image = await loadImage(src);
  const { naturalWidth: width, naturalHeight: height } = image;
  if (width > 8192 || height > 8192 || width * height > 32_000_000)
    throw new Error("图片像素过大，请缩小至 3200 万像素以内。");
  if (width < 6 || height < 4) throw new Error("图片尺寸不足以切分 24 帧。");
  const cellWidth = width / 6,
    cellHeight = height / 4;
  const side = Math.min(cellWidth, cellHeight);
  // Historical offsets use the 360px preview coordinate system, regardless of export size.
  const scale = PREVIEW_SIZE / side;
  const frames = [];
  for (let index = 0; index < FRAME_COUNT; index++) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const offset = legacyOffsets[index] || { dx: 0, dy: 0 };
    const x =
      (index % 6) * cellWidth + (cellWidth - side) / 2 - offset.dx / scale;
    const y =
      Math.floor(index / 6) * cellHeight +
      (cellHeight - side) / 2 -
      offset.dy / scale;
    canvas
      .getContext("2d")
      .drawImage(image, x, y, side, side, 0, 0, size, size);
    frames.push(canvas.toDataURL("image/png"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}

async function imageDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function App() {
  const [prompt, setPrompt] = useState(() => restorePromptInput(readStoredSetting("prompt", "")));
  const [exportFormat, setExportFormat] = useState("gif");
  const [exportSize, setExportSize] = useState(PREVIEW_SIZE);
  const [referenceImage, setReferenceImage] = useState(null);
  const [connection, setConnection] = useState(null);
  const [clips, setClips] = useState(() => [emptyClip()]);
  const [clipIndex, setClipIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationMode, setGenerationMode] = useState(null);
  const [generationStage, setGenerationStage] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [pendingRecovery, setPendingRecovery] = useState(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [imageDragOver, setImageDragOver] = useState(false);
  const [resultAction, setResultAction] = useState(null);
  const referenceFileRef = useRef(null);
  const referenceReadRef = useRef(0);
  const promptInputRef = useRef(null);
  const taskRef = useRef(null);
  const cancelledRef = useRef(false);
  const stoppingRef = useRef(false);
  const projectEpoch = useRef(0);
  const busyRef = useRef(false);
  const currentClip = clips[clipIndex] || clips[0];
  const frames = currentClip.frames;
  const playbackFps = 12;
  const busy = generating || polishing || restoring || !!resultAction;
  const referenceOnlyRunning = generating && generationMode === 'reference';
  const animationRunning = generating && generationMode === 'animation';
  const referenceStage = generationStage === 'reference' || generationStage === 'reference-saving';
  busyRef.current = busy;

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ prompt }),
      );
    } catch {
      /* A full storage area must not interrupt editing. */
    }
  }, [prompt]);

  useEffect(
    () =>
      desktop.onProgress((event) => {
        if (taskRef.current === event.id && !cancelledRef.current)
          setProgress(
            event.stage === "creating-reference" ? "正在生成参考图…" : "正在生成动画…",
          );
      }),
    [],
  );
  useEffect(
    () => () => {
      if (taskRef.current) desktop.cancel(taskRef.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!playing || !frames.length) return;
    const timer = setInterval(
      () => setFrameIndex((index) => (index + 1) % frames.length),
      1000 / playbackFps,
    );
    return () => clearInterval(timer);
  }, [playing, frames.length]);

  const projectSnapshot = () => ({
    format: "fox24",
    version: 2,
    prompt,
    referenceImage: referenceImage?.dataUrl || null,
    referenceCrop: normalizeReferenceCrop(referenceImage?.crop),
    referenceTitle: normalizeReferenceTitle(referenceImage?.downloadTitle),
    slots: [{
      sheet: currentClip.sheetSrc || null,
      offsets: currentClip.legacyOffsets || [],
      title: currentClip.title || '',
      prompt: currentClip.usedPrompt || '',
    }],
  });
  const checkpointForRestart = useEffectEvent(async () => {
    // A still-loading recovery must never be replaced with an empty canvas.
    if (restoring || resultAction) return;
    try {
      await desktop.writeRecovery(projectSnapshot());
    } catch (error) {
      setError(`自动保存失败：${error.message}`);
      throw error;
    }
  });
  useEffect(() => desktop.onBeforeDevRestart?.(checkpointForRestart), []);

  const restoreProject = async (project) => {
    referenceReadRef.current++;
    const epoch = ++projectEpoch.current;
    setRestoring(true);
    setError("");
    try {
      const slot = project.slots[0] || {};
      const sheet = slot.sheet || null;
      const decoded = sheet ? await decodeSheet(sheet, slot.offsets || []) : [];
      if (epoch !== projectEpoch.current) return;
      setClips([{ sheetSrc: sheet, frames: decoded, legacyOffsets: slot.offsets || [],
        title: normalizeAnimationTitle(slot.title), usedPrompt: slot.prompt || project.prompt || '' }]);
      setClipIndex(0);
      setFrameIndex(0);
      setPlaying(true);
      setPrompt(restorePromptInput(project.prompt));
      setReferenceImage(project.referenceImage ? { dataUrl: project.referenceImage,
        crop: normalizeReferenceCrop(project.referenceCrop), downloadTitle: normalizeReferenceTitle(project.referenceTitle) } : null);
      setPendingRecovery(null);
    } finally {
      if (epoch === projectEpoch.current) setRestoring(false);
    }
  };
  useEffect(() => {
    let alive = true;
    desktop
      .readRecovery()
      .then(async (project) => {
        if (!alive) return;
        if (
          project &&
          (project.prompt ||
            project.referenceImage ||
            project.slots.some((slot) => slot.sheet))
        ) {
          if (desktop.autoRestoreRecovery)
            await restoreProject(project);
          else setPendingRecovery(project);
        } else setRestoring(false);
      })
      .catch((error) => {
        if (alive) {
          setError(error.message);
          setRestoring(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (restoring || generating || resultAction) return;
    const timer = setTimeout(() => {
      desktop.writeRecovery(projectSnapshot())
        .catch(error => setError(`自动保存失败：${error.message}`));
    }, 700);
    return () => clearTimeout(timer);
  }, [clips, prompt, referenceImage, restoring, generating, resultAction]);

  const resolveExportTitle = async (clip) => {
    const cached = normalizeAnimationTitle(clip.title);
    if (cached) return cached;
    const result = await desktop.title({ id: crypto.randomUUID(),
      referenceImage: clip.sheetSrc, prompt: clip.usedPrompt || '' });
    const title = normalizeAnimationTitle(result.title);
    if (!title) throw new Error('未能生成动画标题，请重试导出。');
    setClips(value => value.map(item => item.sheetSrc === clip.sheetSrc ? { ...item, title } : item));
    return title;
  };
  const downloadReferenceImage = async () => {
    if (!referenceImage || busyRef.current || exporting) return;
    busyRef.current = true;
    setResultAction('download-reference');
    setExportError('');
    try {
      const image = await squareReferenceImage(referenceImage.dataUrl, referenceImage.crop);
      const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image);
      if (!match) throw new Error('参考图格式无效，请更换图片。');
      const imageHash = await imageDigest(image);
      const cached = normalizeReferenceTitle(referenceImage.downloadTitle);
      let title = cached?.imageHash === imageHash ? cached.title : '';
      if (!title) {
        const result = await desktop.title({ id: crypto.randomUUID(), target: 'reference', referenceImage: image });
        title = normalizeAnimationTitle(result.title);
        if (!title) throw new Error('未能生成参考图标题，请重试下载。');
        const downloadTitle = { imageHash, title };
        setReferenceImage(value => value?.dataUrl === referenceImage.dataUrl ? { ...value, downloadTitle } : value);
      }
      const bytes = Uint8Array.from(atob(match[2]), value => value.charCodeAt(0));
      const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
      await downloadBlob(new Blob([bytes], { type: `image/${match[1]}` }), `${title}.${extension}`);
    } catch (error) { setExportError(error.message || '参考图下载失败，请重试。'); }
    finally { busyRef.current = false; setResultAction(null); }
  };
  const deleteResult = async () => {
    if (busyRef.current || exporting || !currentClip.sheetSrc) return;
    busyRef.current = true;
    setResultAction("delete"); setError("");
    try {
      // Clear the checkpoint first so a quick restart cannot reopen the deleted result.
      await desktop.writeRecovery({ ...projectSnapshot(),
        slots: [{ sheet: null, offsets: [], title: '', prompt: '' }] });
      setClips([emptyClip()]); setClipIndex(0); setFrameIndex(0);
      setExportError("");
      requestAnimationFrame(() => promptInputRef.current?.focus());
    } catch (error) { setError(`删除失败，但当前结果仍保留：${error.message}`); }
    finally { busyRef.current = false; setResultAction(null); }
  };
  const setReferenceFromFile = (file) => {
    if (!file || busyRef.current) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("仅支持 PNG、JPEG 或 WebP 参考图。");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("参考图不能超过 8 MB。");
      return;
    }
    const reader = new FileReader();
    const readVersion = ++referenceReadRef.current;
    reader.onload = () => {
      if (readVersion !== referenceReadRef.current || busyRef.current) return;
      setReferenceImage({ dataUrl: String(reader.result) });
      setError("");
      requestAnimationFrame(() => promptInputRef.current?.focus());
    };
    reader.onerror = () => {
      if (readVersion === referenceReadRef.current)
        setError("参考图读取失败，请重试。");
    };
    reader.readAsDataURL(file);
  };
  useEffect(() => {
    const paste = (event) => {
      if (busyRef.current) return;
      const file = Array.from(event.clipboardData?.items || [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (file) {
        event.preventDefault();
        setReferenceFromFile(file);
      }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);

  const generate = async ({ referenceOnly = false } = {}) => {
    if (
      busyRef.current ||
      exporting ||
      !connection?.ready ||
      (!prompt.trim() && (referenceOnly || !referenceImage))
    )
      return;
    busyRef.current = true;
    const animationPrompt = prompt.trim();
    const epoch = ++projectEpoch.current;
    const id = crypto.randomUUID();
    const referenceId = `${id}-reference`;
    const needsReference = referenceOnly || !referenceImage;
    taskRef.current = needsReference ? referenceId : id;
    cancelledRef.current = false;
    stoppingRef.current = false;
    setStopping(false);
    setGenerating(true);
    setGenerationMode(referenceOnly ? 'reference' : 'animation');
    setGenerationStage(needsReference ? 'reference' : 'animation');
    setError("");
    setExportError("");
    setProgress(needsReference ? "正在生成参考图…" : "正在生成动画…");
    try {
      let source = referenceOnly ? null : referenceImage;
      if (!source) {
        const reference = await desktop.generateReference({ id: referenceId, prompt: animationPrompt });
        if (!reference?.image) throw new Error('Codex 未返回参考图片。');
        const dataUrl = await squareReferenceImage(reference.image);
        if (epoch !== projectEpoch.current) return;
        referenceReadRef.current++;
        source = { dataUrl, crop: normalizeReferenceCrop() };
        // Commit the first-stage image before the dependent animation request starts.
        flushSync(() => { setReferenceImage(source); setGenerationStage('reference-saving'); });
        try {
          // Save the completed first stage so an animation failure or restart can reuse it.
          await desktop.writeRecovery({ ...projectSnapshot(), referenceImage: dataUrl, referenceCrop: source.crop });
        } catch (error) { throw new Error(`参考图已生成，但自动保存失败：${error.message}`); }
      }
      if (cancelledRef.current) throw new Error('已取消。');
      if (referenceOnly) return;
      taskRef.current = id;
      setGenerationStage('animation');
      setProgress('正在生成动画…');
      const cropped = await squareReferenceImage(source.dataUrl, normalizeReferenceCrop(source.crop));
      if (cancelledRef.current) throw new Error('已取消。');
      const payload = await desktop.generate({ id, prompt: animationPrompt, referenceImage: cropped });
      if (!payload?.image) throw new Error("Codex 未返回图片。");
      if (cancelledRef.current) throw new Error('已取消。');
      const decoded = await decodeSheet(payload.image);
      if (epoch !== projectEpoch.current) return;
      setClips([{ sheetSrc: payload.image, frames: decoded, legacyOffsets: [],
        title: normalizeAnimationTitle(payload.title), usedPrompt: animationPrompt }]);
      setClipIndex(0);
      setFrameIndex(0);
      setPlaying(true);
    } catch (error) {
      if (epoch === projectEpoch.current) setError(error.message || "生成失败，请重试。");
    } finally {
      if (taskRef.current === id || taskRef.current === referenceId) taskRef.current = null;
      setGenerating(false);
      setGenerationMode(null);
      setGenerationStage(null);
      stoppingRef.current = false;
      setStopping(false);
      setProgress("");
    }
  };
  const polishPrompt = async () => {
    if (
      busyRef.current ||
      !connection?.ready ||
      !prompt.trim()
    )
      return;
    busyRef.current = true;
    const id = crypto.randomUUID();
    taskRef.current = id;
    cancelledRef.current = false;
    stoppingRef.current = false;
    setStopping(false);
    setPolishing(true);
    setError("");
    try {
      const cropped = referenceImage ? await squareReferenceImage(referenceImage.dataUrl, referenceImage.crop) : undefined;
      if (cancelledRef.current) throw new Error('已取消。');
      const result = await desktop.ask({
        id,
        prompt: prompt.trim(),
        referenceImage: cropped,
      });
      if (!cancelledRef.current) setPrompt(result.text);
    } catch (error) {
      setError(error.message);
    } finally {
      if (taskRef.current === id) taskRef.current = null;
      setPolishing(false);
      stoppingRef.current = false;
      setStopping(false);
      setProgress("");
    }
  };
  const cancelJobs = async () => {
    if (stoppingRef.current || !taskRef.current) return;
    const id = taskRef.current;
    stoppingRef.current = true;
    setStopping(true);
    cancelledRef.current = true;
    setProgress("正在取消…");
    try { await desktop.cancel(id); }
    catch (error) {
      if (taskRef.current === id) {
        stoppingRef.current = false;
        setStopping(false);
        setError(error.message);
      }
    }
  };
  const framesToPixels = async (imgs, size) => {
    const pixels = [];
    for (let i = 0; i < imgs.length; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgs[i], 0, 0, size, size);
      pixels.push(ctx.getImageData(0, 0, size, size).data);
      await new Promise((r) => setTimeout(r, 0));
    }
    return pixels;
  };

  const recordVideo = (imgs, size, fps) =>
    new Promise((resolve, reject) => {
      if (!("MediaRecorder" in window))
        return reject(new Error("当前浏览器不支持视频录制"));
      const types = [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm",
      ];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
      if (!mimeType) return reject(new Error("当前环境不支持视频录制"));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 10_000_000,
      });
      const parts = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve({
          blob: new Blob(parts, { type: mimeType }),
          ext: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
        });
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        reject(new Error("视频录制失败"));
      };
      recorder.start();
      const duration = (imgs.length / fps) * 1000;
      const start = performance.now();
      const tick = () => {
        const elapsed = performance.now() - start;
        if (elapsed >= duration + 1000 / fps) {
          recorder.stop();
          return;
        }
        const idx = Math.min(
          imgs.length - 1,
          Math.floor(elapsed / (1000 / fps)),
        );
        ctx.fillStyle = EXPORT_VIDEO_BG;
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(imgs[idx], 0, 0, size, size);
        requestAnimationFrame(tick);
      };
      tick();
    });

  const canvasToWebp = (canvas) =>
    new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));

  const downloadBlob = async (blob, filename) => {
    await desktop.saveFile({
      name: filename,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  };

  const runExport = async () => {
    if (!frames.length || exporting || busyRef.current) return;
    setExporting(true);
    setExportError("");
    try {
      const title = await resolveExportTitle(currentClip);
      const exportFrames = exportSize === PREVIEW_SIZE ? frames
        : await decodeSheet(currentClip.sheetSrc, currentClip.legacyOffsets, exportSize);
      const imgs = await Promise.all(exportFrames.map(loadImage));
      if (exportFormat === "video") {
        const { blob, ext } = await recordVideo(imgs, exportSize, playbackFps);
        await downloadBlob(blob, animationFilename(title, exportSize, ext));
      } else if (exportFormat === "gif") {
        const pixels = await framesToPixels(imgs, exportSize);
        const bytes = await encodeGif({
          frames: pixels,
          width: exportSize,
          height: exportSize,
          fps: playbackFps,
        });
        await downloadBlob(
          new Blob([bytes], { type: "image/gif" }),
          animationFilename(title, exportSize, 'gif'),
        );
      } else {
        const stills = [];
        for (let i = 0; i < imgs.length; i++) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = exportSize;
          canvas
            .getContext("2d")
            .drawImage(imgs[i], 0, 0, exportSize, exportSize);
          const blob = await canvasToWebp(canvas);
          if (!blob || blob.type !== "image/webp")
            throw new Error("当前浏览器不支持导出 WebP");
          stills.push(new Uint8Array(await blob.arrayBuffer()));
        }
        const bytes = encodeAnimatedWebp({
          frameWebps: stills,
          width: exportSize,
          height: exportSize,
          fps: playbackFps,
        });
        await downloadBlob(
          new Blob([bytes], { type: "image/webp" }),
          animationFilename(title, exportSize, 'webp'),
        );
      }
    } catch (error) {
      setExportError(error.message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="app-shell" data-desktop-platform={desktop.platform}>
      <header className="hardware-header">
        <div className="brand-section">
          <img
            className="brand-icon"
            src="/assets/gifmaker-icon/web/icon-48.png"
            srcSet="/assets/gifmaker-icon/web/icon-192.png 2x"
            width="24"
            height="24"
            alt=""
            draggable={false}
          />
          <h1>GifHop</h1>
        </div>
        <div className="header-controls">
          <ExportButton
            format={exportFormat}
            onFormatChange={setExportFormat}
            size={exportSize}
            onSizeChange={setExportSize}
            onExport={runExport}
            exporting={exporting}
            disabled={busy || !frames.length}
          />
        </div>
      </header>
      <main className="workspace">
        <ConnectionStatus status={connection} onStatus={setConnection} busy={generating || polishing} />
        <div className="canvas-stage">
          <div className="preview-pair">
            <section className="preview-window" aria-label="图片上传展示区" aria-busy={referenceStage}>
              <h2 className="preview-window-title">输入图片</h2>
              <div
                className={`preview-panel reference-panel ${imageDragOver ? "is-drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!busy) setImageDragOver(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget))
                    setImageDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setImageDragOver(false);
                  setReferenceFromFile(
                    Array.from(e.dataTransfer?.files || []).find((file) =>
                      file.type.startsWith("image/"),
                    ),
                  );
                }}
              >
                <div className="preview-content">
                  {referenceImage ? (
                    <ReferenceImage
                      src={referenceImage.dataUrl}
                      crop={referenceImage.crop}
                      disabled={busy || exporting}
                      onCropChange={crop => setReferenceImage(value => value && !busyRef.current ? { ...value, crop } : value)}
                    />
                  ) : !referenceStage && (
                    <Button
                      variant="ghost"
                      className="reference-upload"
                      onPress={() => referenceFileRef.current?.click()}
                      isDisabled={busy}
                      aria-label="上传参考图"
                    >
                      <ImagePlus size={24} strokeWidth={1.5} />
                      <span>上传参考图</span>
                      <small>拖入或粘贴 · 最大 8 MB</small>
                    </Button>
                  )}
                  {generationStage === 'reference' && (
                    <div className="preview-loading" role="status">
                      <Spinner />
                      <span>{progress || '正在生成参考图…'}</span>
                    </div>
                  )}
                </div>
                {referenceImage && (
                  <div className="preview-overlay-controls reference-actions preview-hover-controls" role="group" aria-label="输入图片操作">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="reference-replace"
                      onPress={() => referenceFileRef.current?.click()}
                      isDisabled={busy}
                      aria-label="更换图片"
                      title="更换图片"
                    >
                      <ImagePlus size={16} />
                      <span className="action-label">更换图片</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      className="reference-download"
                      onPress={downloadReferenceImage}
                      isDisabled={busy || exporting}
                      isPending={resultAction === 'download-reference'}
                      aria-label={resultAction === 'download-reference' ? '正在下载参考图' : '下载参考图'}
                      title="下载参考图"
                    >
                      {resultAction === 'download-reference' ? <Spinner size="sm" color="current" aria-label="正在下载参考图" /> : <Download size={16} />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      onPress={() => {
                        referenceReadRef.current++;
                        setReferenceImage(null);
                      }}
                      isDisabled={busy}
                      aria-label="移除图片"
                      title="移除图片"
                    >
                      <X size={16} />
                    </Button>
                  </div>
                )}
              </div>
            </section>
            <section className="preview-window" aria-label="生成结果预览" aria-busy={generationStage === 'animation' || restoring}>
              <h2 className="preview-window-title">生成结果</h2>
              <div className="preview-panel result-panel">
                <div className="preview-content">
                  {frames.length > 0 ? (
                    <PreviewImage
                      src={frames[frameIndex % frames.length]}
                      alt="动画预览画面"
                    />
                  ) : pendingRecovery ? (
                    <div className="result-recovery">
                      <p>找到上次的工程</p>
                      <Button size="sm" variant="secondary"
                        isDisabled={resultAction === "recover"} isPending={resultAction === "recover"}
                        onPress={async () => {
                          if (resultAction === "recover") return;
                          setResultAction("recover");
                          try { await restoreProject(pendingRecovery); }
                          catch (error) { setError(error.message); }
                          finally { setResultAction(null); }
                        }}>
                        {resultAction === "recover" ? "恢复中…" : "恢复工程"}
                      </Button>
                      <Button size="sm" variant="ghost" isDisabled={resultAction === "recover"}
                        onPress={() => { setPendingRecovery(null); setRestoring(false); }}>
                        放弃恢复
                      </Button>
                    </div>
                  ) : (!generating || referenceStage) && (
                    <p className="result-empty">等待生成</p>
                  )}
                  {generationStage === 'animation' && (
                    <div className="preview-loading" role="status">
                      <Spinner />
                      <span>{progress || "正在生成动画…"}</span>
                    </div>
                  )}
                </div>
                {!generating && currentClip.sheetSrc && frames.length > 0 && <Button size="sm" variant="ghost" isIconOnly
                  className="preview-delete preview-hover-controls" onPress={deleteResult}
                  isDisabled={busy || exporting} isPending={resultAction === "delete"}
                  aria-label={resultAction === "delete" ? "正在删除…" : "删除当前结果"}
                  title={resultAction === "delete" ? "正在删除…" : "删除当前结果"}>
                  {resultAction === "delete" ? <Spinner size="sm" /> : <Trash2 size={16} />}
                </Button>}
                {frames.length > 0 && !generating && (
                  <Button
                    variant="ghost"
                    isIconOnly
                    className="preview-playback preview-hover-controls"
                    onPress={() => setPlaying((value) => !value)}
                    aria-label={playing ? "暂停播放" : "播放动画"}
                    title={playing ? "暂停播放" : "播放动画"}
                  >
                    {playing ? <Pause size={20} /> : <Play size={20} />}
                  </Button>
                )}
              </div>
            </section>
          </div>
        </div>
        <div className="composer-area">
        <section className="composer" aria-label="动画输入">
          <TextField
            value={prompt}
            onChange={setPrompt}
            isDisabled={busy}
            className="prompt-field"
          >
            <Label className="sr-only">动作描述</Label>
            <TextArea
              ref={promptInputRef}
              className="prompt-textarea"
              rows={1}
              maxLength={4000}
              placeholder={referenceImage ? "描述图片如何动起来…" : "描述想要的动画…"}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  generate();
                }
              }}
            />
          </TextField>
          <div className="composer-actions">
            <Button
              size="sm"
              variant="ghost"
              className="polish-button"
              onPress={polishing ? cancelJobs : polishPrompt}
              isDisabled={polishing ? stopping : busy || !connection?.ready || !prompt.trim()}
              isPending={polishing && stopping}
              aria-label={polishing ? stopping ? '正在取消润色' : '取消润色' : 'AI 润色提示词'}
            >
              {polishing ? stopping ? <Spinner size="sm" color="current" /> : <Square size={14} /> : <Wand2 size={14} />}
              {polishing ? '取消' : '润色'}
            </Button>
            <div className="generate-actions">
              <Button
                size="sm"
                variant="secondary"
                className="generate-reference-button"
                onPress={referenceOnlyRunning ? cancelJobs : () => generate({ referenceOnly: true })}
                isDisabled={referenceOnlyRunning ? stopping : busy || exporting || !connection?.ready || !prompt.trim()}
                aria-label={referenceOnlyRunning ? stopping ? '正在停止参考图生成' : '取消生成参考图' : '生成参考图'}
              >
                {referenceOnlyRunning ? <Square size={14} /> : <ImagePlus size={14} />}
                <span>{referenceOnlyRunning ? stopping ? '正在停止…' : '取消生成' : '生成参考图'}</span>
              </Button>
              <Button
                size="sm"
                className="generate-button"
                onPress={animationRunning ? cancelJobs : () => generate()}
                isDisabled={
                  stopping || (!animationRunning && (busy ||
                  exporting ||
                  !connection?.ready ||
                  (!prompt.trim() && !referenceImage)))
                }
              >
                {animationRunning ? (
                  <Square size={14} />
                ) : (
                  <Sparkles size={15} />
                )}
                <span>{animationRunning ? stopping ? '正在停止…' : "取消生成" : "生成动画"}</span>
              </Button>
            </div>
          </div>
        </section>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        {exportError && <p className="workspace-error" role="alert">{exportError}</p>}
        </div>
      </main>
      <input
        ref={referenceFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          setReferenceFromFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
