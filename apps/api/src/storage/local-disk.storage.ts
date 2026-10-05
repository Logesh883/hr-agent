import { Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { StorageService } from './storage.service.js';

@Injectable()
export class LocalDiskStorage extends StorageService {
  private readonly root = env().STORAGE_DIR;

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('File is missing from storage');
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /** Maps a key to a path inside the storage root, refusing anything that escapes it. */
  private resolve(key: string): string {
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return file;
  }
}
