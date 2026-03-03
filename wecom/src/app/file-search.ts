import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { WecomWebhookTarget } from "../monitor.js";
import { resolveMediaTempDir } from "../media-utils.js";

export type FileSearchItem = { name: string; path: string };
export type FileSearchCriteria = {
  exactNames: string[];
  keywords: string[];
  ext: string | null;
};

export function extractFilenameCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const normalized = text.replace(/[，,；;|]/g, " ");
  const regex = /(?:\/|file:\/\/)?[A-Za-z0-9\u4e00-\u9fa5._-]+\.[A-Za-z0-9]{1,8}/g;
  for (const match of normalized.matchAll(regex)) {
    const value = match[0];
    if (value) candidates.add(value.replace(/^file:\/\//, ""));
  }
  return Array.from(candidates);
}

export function extractSearchKeywords(text: string): string[] {
  const keywords = new Set<string>();
  const cleaned = text
    .replace(/(发给我|发送给我|发我|给我|把|那个|这个|文件|帮我|找|搜索|查找)/g, " ")
    .replace(/[，,；;|。！？\s]+/g, " ")
    .trim();

  const chineseWords = cleaned.match(/[\u4e00-\u9fa5]{2,10}/g) || [];
  for (const word of chineseWords) {
    if (word.length >= 2) keywords.add(word);
  }

  const englishWords = cleaned.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || [];
  for (const word of englishWords) {
    keywords.add(word.toLowerCase());
  }

  const numbers = cleaned.match(/\d{2,}/g) || [];
  for (const num of numbers) {
    keywords.add(num);
  }

  return Array.from(keywords);
}

export function extractExtension(text: string): string | null {
  const match = text.match(/(?:\.|格式|后缀)?\s*([A-Za-z0-9]{2,8})/i);
  if (!match) return null;
  const ext = match[1]?.toLowerCase();
  if (!ext) return null;
  const allowed = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "webp",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "rar", "7z",
    "txt", "log", "csv", "json", "xml", "yaml", "yml",
    "mp3", "wav", "amr", "mp4", "mov",
  ]);
  return allowed.has(ext) ? ext : null;
}

function resolveSearchDirs(text: string, target: WecomWebhookTarget): { path: string; label: string; recursive?: boolean }[] {
  const lower = text.toLowerCase();
  if (text.includes("桌面")) return [{ path: join(homedir(), "Desktop"), label: "桌面", recursive: true }];
  if (text.includes("下载") || lower.includes("download")) return [{ path: join(homedir(), "Downloads"), label: "下载", recursive: true }];
  if (text.includes("文档") || lower.includes("document")) return [{ path: join(homedir(), "Documents"), label: "文档", recursive: true }];
  if (text.includes("临时") || lower.includes("tmp")) return [{ path: resolveMediaTempDir(target), label: "临时目录", recursive: true }];
  if (text.includes("工作") || lower.includes("work")) {
    const workspace = target.account.config.workspace;
    if (workspace) {
      const resolved = workspace.startsWith("~") ? join(homedir(), workspace.slice(1)) : workspace;
      return [{ path: resolved, label: "工作目录", recursive: true }];
    }
  }

  const dirs: { path: string; label: string; recursive?: boolean }[] = [];
  const configPaths = target.account.config.media?.searchPaths;
  if (configPaths && Array.isArray(configPaths)) {
    for (const p of configPaths) {
      const resolved = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
      dirs.push({ path: resolved, label: basename(resolved) || p, recursive: true });
    }
  }

  if (dirs.length === 0) {
    dirs.push({ path: join(homedir(), "Desktop"), label: "桌面", recursive: true });
    dirs.push({ path: join(homedir(), "Downloads"), label: "下载", recursive: true });
    dirs.push({ path: join(homedir(), "Documents"), label: "文档", recursive: false });
    dirs.push({ path: resolveMediaTempDir(target), label: "临时目录", recursive: true });
  }

  return dirs;
}

async function readdirRecursive(
  dir: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
): Promise<{ name: string; path: string; relativePath: string }[]> {
  const results: { name: string; path: string; relativePath: string }[] = [];
  if (currentDepth > maxDepth) return results;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "__pycache__", ".git", ".svn", "vendor"].includes(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath: entry.name,
        });
      } else if (entry.isDirectory() && currentDepth < maxDepth) {
        const subResults = await readdirRecursive(fullPath, maxDepth, currentDepth + 1);
        for (const sub of subResults) {
          results.push({
            name: sub.name,
            path: sub.path,
            relativePath: join(entry.name, sub.relativePath),
          });
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
  return results;
}

function fuzzyMatchFile(
  filename: string,
  keywords: string[],
  exactNames: string[],
): { score: number; matchType: "exact" | "fuzzy" | "none" } {
  const lowerFilename = filename.toLowerCase();
  const nameWithoutExt = lowerFilename.replace(/\.[^.]+$/, "");

  for (const exact of exactNames) {
    if (lowerFilename === exact.toLowerCase()) {
      return { score: 100, matchType: "exact" };
    }
  }

  let matchedKeywords = 0;
  let totalScore = 0;
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (lowerFilename.includes(lowerKeyword) || nameWithoutExt.includes(lowerKeyword)) {
      matchedKeywords++;
      totalScore += Math.min(keyword.length * 10, 50);
    }
  }

  if (matchedKeywords > 0) {
    totalScore += matchedKeywords * 20;
    return { score: Math.min(totalScore, 90), matchType: "fuzzy" };
  }

  return { score: 0, matchType: "none" };
}

async function resolveSampleFiles(searchDirs: { path: string; label: string }[]): Promise<string[]> {
  const sampleFiles: string[] = [];
  for (const searchDir of searchDirs) {
    try {
      const entries = await readdir(searchDir.path);
      for (const entry of entries.slice(0, 3)) {
        if (!entry.startsWith(".")) sampleFiles.push(entry);
      }
      if (sampleFiles.length >= 5) break;
    } catch {
      // ignore
    }
  }
  return sampleFiles;
}

export function resolveFileSearchCriteria(text: string): FileSearchCriteria {
  return {
    exactNames: extractFilenameCandidates(text),
    keywords: extractSearchKeywords(text),
    ext: extractExtension(text),
  };
}

export async function findFilesByNaturalText(params: {
  target: WecomWebhookTarget;
  text: string;
  criteria?: FileSearchCriteria;
}): Promise<{
  exactNames: string[];
  keywords: string[];
  ext: string | null;
  resolved: FileSearchItem[];
  foundInDir: string;
  searchDirs: { path: string; label: string; recursive?: boolean }[];
  sampleFiles: string[];
}> {
  const { target, text, criteria } = params;
  const resolvedCriteria = criteria ?? resolveFileSearchCriteria(text);
  const { exactNames, keywords, ext } = resolvedCriteria;
  const searchDirs = resolveSearchDirs(text, target);

  const allEntries: Map<string, { name: string; path: string; dir: string; score: number }> = new Map();
  for (const searchDir of searchDirs) {
    try {
      const maxDepth = searchDir.recursive ? 3 : 0;
      const entries = await readdirRecursive(searchDir.path, maxDepth);
      for (const entry of entries) {
        const { score } = fuzzyMatchFile(entry.name, keywords, exactNames);
        const matchesExt = ext && entry.name.toLowerCase().endsWith(`.${ext}`);
        if (score > 0 || matchesExt) {
          const finalScore = matchesExt ? Math.max(score, 50) : score;
          const existing = allEntries.get(entry.path);
          if (!existing || existing.score < finalScore) {
            allEntries.set(entry.path, {
              name: entry.relativePath,
              path: entry.path,
              dir: searchDir.label,
              score: finalScore,
            });
          }
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  const sortedEntries = Array.from(allEntries.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);

  const resolved: FileSearchItem[] = [];
  let foundInDir = "";

  for (const name of exactNames) {
    if (name.startsWith("/")) {
      try {
        const info = await stat(name);
        if (info.isFile()) {
          resolved.push({ name: basename(name), path: name });
        }
      } catch {
        // ignore
      }
    }
  }

  for (const entry of sortedEntries) {
    if (!resolved.some((r) => r.path === entry.path)) {
      resolved.push({ name: entry.name, path: entry.path });
      if (!foundInDir) foundInDir = entry.dir;
    }
  }

  const sampleFiles = resolved.length === 0 ? await resolveSampleFiles(searchDirs) : [];

  return {
    exactNames,
    keywords,
    ext,
    resolved,
    foundInDir,
    searchDirs,
    sampleFiles,
  };
}
