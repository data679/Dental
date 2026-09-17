import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_FILE_RE } from "./delimited.js";

// Text files that ride along in a download but aren't tables.
const NOT_DATA_RE = /(^|[\\/])(readme|read_me|license|licence|manifest|changelog|notes?|data_?dictionary)\.[^.]+$/i;
const isDataFile = (f: string) => DATA_FILE_RE.test(f) && !NOT_DATA_RE.test(f);

const execFileAsync = promisify(execFile);

// The download is a zip encrypted with AES-128 (password = the requesting Denticon
// user's password). Node's zlib can't do encrypted zips, so extraction shells out to 7z,
// which handles AES; when 7z isn't installed the caller gets a clear message and can
// extract by hand and point the loader at the folder instead.

export interface ExtractedFeed {
  /** Folder holding the flat files (the zip's extraction dir, or the dir given). */
  dir: string;
  /** Data files found, relative to `dir`, sorted. Format/readme files are excluded. */
  files: string[];
  /** All files, for the inspect report. */
  allFiles: string[];
  /** Call when done to remove the temp extraction dir (no-op for a plain folder). */
  cleanup: () => Promise<void>;
}

export class ArchiveError extends Error {}

export async function openFeed(source: string, password?: string): Promise<ExtractedFeed> {
  const st = await stat(source).catch(() => null);
  if (!st) throw new ArchiveError(`${source}: not found`);

  if (st.isDirectory()) {
    const allFiles = await listFiles(source);
    return { dir: source, files: allFiles.filter(isDataFile), allFiles, cleanup: async () => {} };
  }
  if (!/\.(zip|7z)$/i.test(source)) {
    throw new ArchiveError(`${source}: expected a .zip/.7z file or a folder of extracted files`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "denticon-bcp-"));
  try {
    await extractWith7z(source, dir, password);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const allFiles = await listFiles(dir);
  return {
    dir,
    files: allFiles.filter(isDataFile),
    allFiles,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function extractWith7z(archive: string, dest: string, password?: string): Promise<void> {
  const bin = process.env.SEVEN_ZIP_BIN || "7z";
  // -p with no value asks 7z to fail rather than prompt when a password is needed.
  const args = ["x", "-y", `-o${dest}`, `-p${password ?? ""}`, archive];
  try {
    await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new ArchiveError(
        `7z is not installed (looked for "${bin}"). Install p7zip, set SEVEN_ZIP_BIN, or extract the zip yourself and pass the folder.`,
      );
    }
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (/password/i.test(out) && !password) {
      throw new ArchiveError("The download zip is password-protected; set DENTICON_BCP_PASSWORD to the requesting user's Denticon password.");
    }
    if (/wrong password/i.test(out)) {
      throw new ArchiveError("Wrong password for the download zip (DENTICON_BCP_PASSWORD must be the requesting user's Denticon password).");
    }
    // Never echo the command line — it carries the password.
    throw new ArchiveError(`7z failed extracting ${path.basename(archive)}: ${(e.stderr ?? e.message ?? "").trim().slice(0, 500)}`);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) out.push(relPath);
    }
  };
  await walk("");
  return out.sort();
}
