import React, { useEffect, useState } from "react";
import { Button, Label, Menu, Popover, Spinner } from "@heroui/react";
import { ChevronDown, Download } from "lucide-react";

const formats = [
  { id: "gif", label: "GIF" },
  { id: "webp", label: "WebP" },
  { id: "video", label: "视频" },
];
export const DEFAULT_EXPORT_SIZE = 320;
const sizes = [40, 80, 160, 240, DEFAULT_EXPORT_SIZE, 480];

export function ExportButton({ format, onFormatChange, size, onSizeChange, onExport, exporting, disabled }) {
  const [open, setOpen] = useState(false);
  const label = formats.find(item => item.id === format)?.label || "GIF";
  const action = exporting ? "导出中…" : format === "video" ? "导出视频" : `导出 ${label}`;
  const locked = disabled || exporting;
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  return (
    <div className="export-controls" role="group" aria-label="导出动画">
      <Button size="sm" variant="primary" className="export-action" onPress={onExport}
        isDisabled={locked} isPending={exporting} aria-label={action}>
        {exporting ? <Spinner size="sm" color="current" aria-label="正在导出" /> : <Download size={14} />}
        <span>{action}</span>
      </Button>
      <Popover isOpen={open && !locked} onOpenChange={setOpen}>
        <Button size="sm" variant="primary" isIconOnly className="export-format-trigger"
          isDisabled={locked} aria-label="选择导出格式和尺寸" aria-haspopup="dialog">
          <ChevronDown size={14} />
        </Button>
        <Popover.Content placement="bottom end" className="export-format-popover">
          <Popover.Dialog aria-label="导出选项" className="export-options">
            <div className="export-option-group">
              <p className="export-option-heading" aria-hidden="true">格式</p>
              <Menu aria-label="导出格式" autoFocus="first" selectionMode="single" disallowEmptySelection selectedKeys={[format]} onAction={key => {
                if (locked || !formats.some(item => item.id === key)) return;
                onFormatChange(key);
                setOpen(false);
              }}>
                {formats.map(item => (
                  <Menu.Item key={item.id} id={item.id} textValue={item.label}>
                    <Label>{item.label}</Label>
                    <Menu.ItemIndicator />
                  </Menu.Item>
                ))}
              </Menu>
            </div>
            <div className="export-option-group">
              <p className="export-option-heading" aria-hidden="true">尺寸 · px</p>
              <Menu aria-label="导出尺寸" selectionMode="single" disallowEmptySelection selectedKeys={[String(size)]} onAction={key => {
                if (locked || !sizes.includes(Number(key))) return;
                onSizeChange(Number(key));
                setOpen(false);
              }}>
                {sizes.map(value => (
                  <Menu.Item key={value} id={String(value)} textValue={`${value} × ${value}`}>
                    <Label>{value} × {value}</Label>
                    <Menu.ItemIndicator />
                  </Menu.Item>
                ))}
              </Menu>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}
