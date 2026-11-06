# Shows the native Windows folder dialog and prints the chosen path. Prints nothing when cancelled.
param(
  [string]$Start = '',
  [string]$Title = 'Choose working directory'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DsxFolderPicker {
  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  private class FileOpenDialog {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  private interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid riid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint type, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string path, IntPtr context, [In] ref Guid riid, out IShellItem item);

  private const uint WS_POPUP = 0x80000000;
  private const uint WS_EX_TOPMOST = 0x8;
  private const uint WS_EX_TOOLWINDOW = 0x80;

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out RECT bounds);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

  [DllImport("user32.dll")]
  private static extern bool DestroyWindow(IntPtr window);

  public static string Pick(string title, string start) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    dialog.SetTitle(title);

    if (!string.IsNullOrEmpty(start)) {
      try {
        var riid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref riid, out folder);
        dialog.SetFolder(folder);
      } catch (COMException) {
        // A missing start folder only means the dialog opens at its default location.
      }
    }

    // A modal dialog disables its owner, and stays that way if this process dies. So the owner is a
    // hidden window of our own, kept on top and placed over the window the user just clicked in.
    RECT bounds;
    GetWindowRect(GetForegroundWindow(), out bounds);
    IntPtr owner = CreateWindowEx(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, "STATIC", "", WS_POPUP,
      (bounds.Left + bounds.Right) / 2, (bounds.Top + bounds.Bottom) / 2, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    int result = dialog.Show(owner);
    DestroyWindow(owner);
    if (result == ERROR_CANCELLED) return null;
    Marshal.ThrowExceptionForHR(result);

    IShellItem item;
    string path;
    dialog.GetResult(out item);
    item.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
'@

$path = [DsxFolderPicker]::Pick($Title, $Start)
if ($path) { Write-Output $path }
