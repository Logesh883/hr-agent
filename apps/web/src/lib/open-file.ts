"use client";

import { apiDownload } from "./api";
import { useAccessToken } from "./session";

/** Opens an authenticated API file in a new tab (or downloads it if the tab is blocked). */
export function useOpenFile() {
  const token = useAccessToken();
  return async (path: string, fileName: string) => {
    // Open the tab synchronously so popup blockers allow it, then point it at the file.
    const tab = window.open("", "_blank");
    try {
      const url = URL.createObjectURL(await apiDownload(token, path));
      if (tab) tab.location.href = url;
      else downloadUrl(url, fileName);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      throw error;
    }
  };
}

/** Downloads an authenticated API file under the given name. */
export function useDownloadFile() {
  const token = useAccessToken();
  return async (path: string, fileName: string) => {
    const url = URL.createObjectURL(await apiDownload(token, path));
    downloadUrl(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
}

function downloadUrl(url: string, fileName: string) {
  Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
}
