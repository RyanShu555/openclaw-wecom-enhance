import { readFile } from "node:fs/promises";

type InboundMediaLike = {
  type?: string;
  path?: string;
  mimeType?: string;
} | null | undefined;

type ImageContentLike = {
  type: "image";
  data: string;
  mimeType: string;
};

function resolveImageMimeType(media: NonNullable<InboundMediaLike>): string {
  const mt = media.mimeType?.trim().toLowerCase();
  if (mt && mt.startsWith("image/")) return mt;
  return "image/jpeg";
}

/**
 * 将入站图片媒体转换为 OpenClaw GetReplyOptions.images 结构。
 * 仅做文件读取与编码，不做任何识别/分析。
 */
export async function buildInboundImages(
  media: InboundMediaLike,
  maxBytes?: number,
): Promise<ImageContentLike[] | undefined> {
  if (!media || media.type !== "image" || !media.path) return undefined;
  try {
    const buffer = await readFile(media.path);
    if (!buffer.length) return undefined;
    if (maxBytes && buffer.length > maxBytes) return undefined;
    return [{
      type: "image",
      data: buffer.toString("base64"),
      mimeType: resolveImageMimeType(media),
    }];
  } catch {
    return undefined;
  }
}

