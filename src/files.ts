// Local disk access for the stdio server, which runs on the user's machine.
// Tool arguments come from a model that also reads text from websites and
// directories, so a path is never trusted: images are read only from one
// folder, without following links, and must really be images; reports are
// written only as report files and never over an existing file.
import { constants } from 'node:fs';
import { open, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { LocalFiles } from './tools/types.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The folder images may be read from: SUBMITATOR_FILES_DIR, or the folder
// the client started the server in. Never the whole disk or the home folder.
export function imagesFolder(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  const folder = resolve(env.SUBMITATOR_FILES_DIR?.trim() || cwd);
  if (folder === parse(folder).root || folder === resolve(homedir())) return undefined;
  return folder;
}

// The folder reports go to unless the call names one.
export async function reportsFolder(): Promise<string> {
  const downloads = join(homedir(), 'Downloads');
  const info = await stat(downloads).catch(() => null);
  return info?.isDirectory() ? downloads : homedir();
}

function sniff(bytes: Uint8Array): { type: string; extension: string } | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: 'image/png', extension: 'png' };
  if (at(0, 0xff, 0xd8, 0xff)) return { type: 'image/jpeg', extension: 'jpg' };
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return { type: 'image/gif', extension: 'gif' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { type: 'image/webp', extension: 'webp' };
  return undefined;
}

export function localFiles(folder: string | undefined = imagesFolder()): LocalFiles {
  return {
    async read(path) {
      // One answer for a missing file and a refused one: no probing of the disk.
      const refused = new Error(
        folder
          ? `No image at that path inside ${folder}. Put the file there, or set SUBMITATOR_FILES_DIR to its folder.`
          : 'Local files are off: the server was started in the home folder or the disk root. Set SUBMITATOR_FILES_DIR to the folder with the images.',
      );
      if (!folder) throw refused;
      const root = await realpath(folder).catch(() => null);
      const target = await realpath(isAbsolute(path) ? path : join(folder, path)).catch(() => null);
      if (!root || !target) throw refused;
      const inside = relative(root, target);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).some((part) => part.startsWith('.'))) {
        throw refused;
      }
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
      if (!handle) throw refused;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw refused;
        if (info.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than 5 MB.');
        const buffer = new Uint8Array(new ArrayBuffer(MAX_IMAGE_BYTES + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
        if (bytesRead > MAX_IMAGE_BYTES) throw new Error('The image is larger than 5 MB.');
        const bytes = buffer.slice(0, bytesRead);
        const kind = sniff(bytes);
        if (!kind) throw new Error('That file is not a PNG, JPEG, GIF or WebP image.');
        return { bytes, ...kind };
      } finally {
        await handle.close();
      }
    },

    async write(directory, fileName, bytes) {
      const target = resolve(directory ?? (await reportsFolder()));
      const info = await stat(target).catch(() => null);
      if (!info?.isDirectory()) throw new Error(`There is no folder at ${target}.`);
      const name = basename(fileName).replace(/[^\w. -]+/g, '_').replace(/^\.+/, '') || 'report';
      const path = await freePath(target, name);
      // "wx" never overwrites, and fails on a link planted at the name.
      await writeFile(path, bytes, { flag: 'wx' });
      return { path, size: bytes.byteLength };
    },
  };
}

async function freePath(folder: string, name: string): Promise<string> {
  const { name: stem, ext } = parse(name);
  for (let copy = 0; copy < 1000; copy += 1) {
    const candidate = join(folder, copy === 0 ? name : `${stem} (${copy})${ext}`);
    const taken = await stat(candidate).then(
      () => true,
      () => false,
    );
    if (!taken) return candidate;
  }
  throw new Error(`Too many files named ${name} in ${folder}.`);
}
