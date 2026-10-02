import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_DOCUMENT_CHARS } from "./model.js";
export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const markdownFile = (name: string) => /\.(md|markdown)$/i.test(name);
/** Resolve only existing Markdown files inside this session's workspace. */
export async function workspaceFile(workspace: string, input: string, allowMissing = false) {
  const root = await realpath(workspace);
  const requested = path.resolve(root, input);
  const relative = path.relative(root, requested);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("Choose a Markdown file inside this session's workspace.");
  // Reject symlink components: opening a workspace document never follows a link to a secret or another workspace.
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error("Choose a file directly in the workspace, not a symbolic link.");
  }
  if (!markdownFile(requested)) throw new Error("Choose a .md or .markdown document.");
  return requested;
}
/** Publish a complete new file without ever replacing an existing destination. */
export async function createMarkdown(workspace: string, input: string, markdown: string) {
  const filePath = await workspaceFile(workspace, input, true);
  const root = await realpath(workspace);
  let directory = root;
  for (const part of path.relative(root, path.dirname(filePath)).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Choose a folder directly in the workspace, not a symbolic link.");
  }
  const temporary = path.join(directory, `.${path.basename(filePath)}.collab-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    let identity;
    try {
      await handle.writeFile(markdown);
      await handle.sync();
      identity = await handle.stat();
    } finally {
      await handle.close();
    }
    await workspaceFile(workspace, input, true);
    await link(temporary, filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error("A file already exists at that path. Choose a different name.");
      throw error;
    });
    return async () => {
      // If publishing Collab's state fails, remove only the file we just created.
      const current = await lstat(filePath).catch(() => undefined);
      if (
        current?.dev === identity.dev &&
        current.ino === identity.ino &&
        (await readMarkdown(workspace, filePath)).fileHash === fingerprint(markdown)
      )
        await unlink(filePath);
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function readMarkdown(workspace: string, input: string) {
  const filePath = await workspaceFile(workspace, input);
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 240000)
      throw new Error("Choose a Markdown document under 60,000 characters.");
    const markdown = await handle.readFile("utf8");
    if (markdown.length > MAX_DOCUMENT_CHARS || Buffer.byteLength(markdown) > 64000)
      throw new Error("Choose a smaller Markdown document (under 60,000 characters / 64 KB).");
    return { filePath, markdown, fileHash: fingerprint(markdown) };
  } finally {
    await handle.close();
  }
}
const fileTails = new Map<string, Promise<unknown>>();
async function withFileLocks<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const pending = Promise.all(paths.map((file) => fileTails.get(file))).then(operation);
  const tail = pending.catch(() => {});
  for (const file of paths) fileTails.set(file, tail);
  try {
    return await pending;
  } finally {
    for (const file of paths) if (fileTails.get(file) === tail) fileTails.delete(file);
  }
}
/** Rename without clobbering another file, retaining a reversible link until publication. */
export async function renameMarkdown(
  workspace: string,
  from: string,
  to: string,
  expected: string,
) {
  return withFileLocks([from, to], async () => {
    const source = await readMarkdown(workspace, from);
    await workspaceFile(workspace, to, true);
    if (source.fileHash !== expected)
      throw new Error("The Markdown file changed outside Collab. Reload it before renaming.");
    const identity = await lstat(from);
    const sameFile = async (file: string) => {
      const stat = await lstat(file).catch(() => undefined);
      return stat?.dev === identity.dev && stat.ino === identity.ino && !stat.isSymbolicLink();
    };
    const destination = await lstat(to).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // On a case-insensitive filesystem, a case-only rename is the same directory entry.
    const caseOnly =
      !!destination &&
      (await sameFile(to)) &&
      !(await readdir(path.dirname(to))).includes(path.basename(to));
    if (destination && !caseOnly)
      throw new Error("A file already exists with that name. Choose a different name.");
    const temporary = path.join(
      path.dirname(from),
      `.${path.basename(from)}.collab-${randomUUID()}`,
    );
    await link(from, temporary);
    let removedSource = false,
      createdDestination = false,
      keepBackup = false;
    try {
      if (!(await sameFile(from)) || (await readMarkdown(workspace, from)).fileHash !== expected)
        throw new Error("The Markdown file changed outside Collab. Reload it before renaming.");
      if (caseOnly) {
        await unlink(from);
        removedSource = true;
      }
      await link(temporary, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error("A file already exists with that name. Choose a different name.");
        throw error;
      });
      createdDestination = true;
      if (!removedSource) {
        if (!(await sameFile(from)) || (await readMarkdown(workspace, from)).fileHash !== expected)
          throw new Error("The Markdown file changed outside Collab. Reload it before renaming.");
        await unlink(from);
        removedSource = true;
      }
    } catch (error) {
      if (createdDestination && (await sameFile(to))) await unlink(to);
      if (removedSource) {
        await link(temporary, from).catch(() => {
          keepBackup = true;
        });
      }
      if (keepBackup)
        throw new Error(`Rename could not finish. The original file is preserved at ${temporary}.`);
      throw error;
    } finally {
      if (!keepBackup) await unlink(temporary);
    }
    return async () => {
      await renameMarkdown(workspace, to, from, expected);
    };
  });
}
export async function writeMarkdown(
  workspace: string,
  filePath: string,
  expected: string,
  markdown: string,
) {
  await withFileLocks([filePath], async () => {
    const current = await readMarkdown(workspace, filePath);
    if (current.fileHash !== expected)
      throw new Error(
        "The Markdown file changed outside Collab. Your draft is preserved; reopen the file to load its latest version.",
      );
    const mode = (await lstat(filePath)).mode;
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.collab-${randomUUID()}`,
    );
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(markdown);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Recheck after staging, before replacing the workspace artifact.
      if ((await readMarkdown(workspace, filePath)).fileHash !== expected)
        throw new Error("The Markdown file changed outside Collab. Your draft is preserved.");
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  return fingerprint(markdown);
}
export async function listMarkdown(workspace: string, query = "") {
  const root = await realpath(workspace);
  const files: { path: string; name: string; modifiedAt: string }[] = [];
  let visited = 0;
  let truncated = false;
  async function visit(directory: string, depth: number) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 8000) {
        truncated = true;
        return;
      }
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "dist", "build", "vendor"].includes(entry.name)
      )
        continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 5) await visit(absolute, depth + 1);
        else truncated = true;
      } else if (entry.isFile() && markdownFile(entry.name)) {
        const relative = path.relative(root, absolute);
        if (relative.toLowerCase().includes(query.toLowerCase())) {
          const stat = await lstat(absolute);
          files.push({ path: relative, name: entry.name, modifiedAt: stat.mtime.toISOString() });
        }
      }
    }
  }
  await visit(root, 0);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return {
    workspace: root,
    files: files.slice(0, 100),
    truncated: truncated || files.length > 100,
  };
}
