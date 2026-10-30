import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagesFolder, localFiles } from '../src/files.js';

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), 'submitator-mcp-')));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('imagesFolder', () => {
  it('uses SUBMITATOR_FILES_DIR, then the starting folder', () => {
    expect(imagesFolder({ SUBMITATOR_FILES_DIR: '/srv/assets' }, '/work')).toBe('/srv/assets');
    expect(imagesFolder({}, '/work/acme')).toBe('/work/acme');
  });

  it('never opens the whole disk or the home folder', () => {
    expect(imagesFolder({}, '/')).toBeUndefined();
    expect(imagesFolder({}, homedir())).toBeUndefined();
  });
});

describe('localFiles.read', () => {
  it('reads an image inside the folder, typed by its bytes', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'logo.dat'), PNG);
    const file = await localFiles(dir).read('logo.dat');
    expect(file).toMatchObject({ type: 'image/png', extension: 'png' });
    expect(file.bytes.byteLength).toBe(PNG.byteLength);
  });

  it('refuses what is not an image, whatever its name says', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'notes.png'), 'aws_secret_access_key = x');
    await expect(localFiles(dir).read('notes.png')).rejects.toThrow(/not a PNG, JPEG, GIF or WebP/);
  });

  it('refuses paths outside the folder, hidden ones and links out of it, with one answer', async () => {
    const dir = folder();
    const outside = folder();
    writeFileSync(join(outside, 'secret.png'), PNG);
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, '.ssh', 'key.png'), PNG);
    symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'));
    const files = localFiles(dir);
    const answers = await Promise.all(
      [join(outside, 'secret.png'), '../secret.png', '.ssh/key.png', 'link.png', 'missing.png'].map((path) =>
        files.read(path).then(
          () => 'read',
          (error: Error) => error.message,
        ),
      ),
    );
    expect(new Set(answers)).toEqual(new Set([`No image at that path inside ${dir}. Put the file there, or set SUBMITATOR_FILES_DIR to its folder.`]));
  });

  it('refuses files over 5 MB', async () => {
    const dir = folder();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    writeFileSync(join(dir, 'big.png'), big);
    await expect(localFiles(dir).read('big.png')).rejects.toThrow(/5 MB/);
  });

  it('is off when there is no safe folder', async () => {
    await expect(localFiles(undefined).read('/tmp/x.png')).rejects.toThrow(/SUBMITATOR_FILES_DIR/);
  });
});

describe('localFiles.write', () => {
  it('never overwrites: a second copy gets a number', async () => {
    const dir = folder();
    const files = localFiles(dir);
    const first = await files.write(dir, 'acme.pdf', new Uint8Array([1]));
    const second = await files.write(dir, 'acme.pdf', new Uint8Array([2]));
    expect(first.path).toBe(join(dir, 'acme.pdf'));
    expect(second.path).toBe(join(dir, 'acme (1).pdf'));
    expect(readFileSync(first.path)[0]).toBe(1);
  });

  it('keeps the name inside the folder and never hidden', async () => {
    const dir = folder();
    const files = localFiles(dir);
    expect((await files.write(dir, '../../etc/passwd', new Uint8Array([1]))).path).toBe(join(dir, 'passwd'));
    expect((await files.write(dir, '.bashrc.pdf', new Uint8Array([1]))).path).toBe(join(dir, 'bashrc.pdf'));
  });

  it('refuses a folder that does not exist', async () => {
    await expect(localFiles(folder()).write(join(folder(), 'missing'), 'a.pdf', new Uint8Array([1]))).rejects.toThrow(/no folder/);
  });
});
