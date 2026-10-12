
import { Notice } from 'obsidian';
import { posix, win32 } from 'path';
import { Platform } from 'obsidian';


interface ElectronDialog {
  showOpenDialog(options: {
    properties: Array<"openDirectory" | "openFile">;
    defaultPath?: string;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronBridge {
  dialog?: ElectronDialog;
  remote?: { dialog?: ElectronDialog };
}

interface WindowWithRequire extends Window {
  require?: (moduleName: string) => ElectronBridge;
}

export async function pickPathBrowser(
    mode: "openDirectory" | "openFile",
    initialPath?: string,
  ): Promise<string | null> {
    try {
      const electron = (window as WindowWithRequire).require?.("electron") ?? null;
      const dialog = electron?.remote?.dialog ?? electron?.dialog;
      if (!dialog) {
        throw new Error(
          "Electron dialog API is not available in this environment.",
        );
      }

      const initialPathValue = initialPath?.trim() || undefined;
      // If we are requesting a file, get the dirname using win32.dirname if the path is a Windows-style path
      // otherwise the electron dialog does not open the correct path
      // When we are requesting a folder, we can use the initial path as is

      let defaultPath: string | undefined;
      if (initialPathValue) {
        defaultPath = Platform.isWin
          ? win32.dirname(win32.normalize(initialPathValue))
          : posix.dirname(posix.normalize(initialPathValue));
      }
      
      const result = await dialog.showOpenDialog({
        properties: [mode],
        defaultPath,
      });

      const [selectedPath] = result.filePaths;
      if (result.canceled || !selectedPath) {
        return null;
      }

      return selectedPath;
    } catch (error) {
      new Notice(`Picker failed: ${(error as Error).message}`);
      return null;
    }
  }