import fs from "node:fs/promises";

async function readTextIfPresent<T = null>(filePath: string, fallback: T): Promise<string | T> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeTextIfChanged(filePath: string, content: string): Promise<boolean> {
  const current = await readTextIfPresent(filePath, null);
  if (current === content) return false;
  await fs.writeFile(filePath, content);
  return true;
}

export {
  readTextIfPresent,
  writeTextIfChanged
};
