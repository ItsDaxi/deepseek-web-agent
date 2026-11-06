// Windows setup for DeepSeek Web Agent: a single exe that needs no admin rights and no Node.js.
// Written for the C# 5 compiler that ships with every Windows, so it builds with no extra tools.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DsxSetup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            bool uninstall = args.Contains("--uninstall");
            int renderFlag = Array.IndexOf(args, "--render");

            if (args.Contains("--silent"))
            {
                try
                {
                    if (uninstall) Installer.Uninstall();
                    else Installer.Install(delegate { });
                    return 0;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.Message);
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (renderFlag >= 0)
            {
                WizardForm.RenderPages(args[renderFlag + 1]);
                return 0;
            }
            Application.Run(new WizardForm(uninstall));
            return 0;
        }
    }

    class Browser
    {
        public string Name;
        public string Executable;
        public string ExtensionsUrl;
        public string UserData;
    }

    static class Installer
    {
        public const string AppName = "DeepSeek Web Agent";
        const string HostName = "com.dsx.shell_host";
        const string ExtensionId = "hacpjcoldiccblakbdgcnccmlehckaek";
        // This key and the folder name below keep the old product name, so a setup run over an older
        // install updates it in place and one uninstall entry never turns into two.
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekShellTool";

        // Brave has no registry path of its own on Windows: it reads the Chromium and Chrome ones.
        static readonly string[] HostKeys =
        {
            @"Software\Google\Chrome\NativeMessagingHosts\" + HostName,
            @"Software\Chromium\NativeMessagingHosts\" + HostName,
            @"Software\Microsoft\Edge\NativeMessagingHosts\" + HostName,
        };

        static string LocalAppData { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }

        public static string AppDir { get { return Path.Combine(LocalAppData, "DeepSeekShellTool"); } }
        public static string ExtensionDir { get { return Path.Combine(AppDir, "extension"); } }

        public static void Install(Action<int, string> progress)
        {
            progress(5, "Stopping the previous version");
            StopRunningHosts();

            progress(10, "Copying files");
            Directory.CreateDirectory(AppDir);
            ExtractPayload(delegate(int percent) { progress(10 + percent * 70 / 100, "Copying files"); });

            progress(85, "Connecting to your browsers");
            string launcher = Path.Combine(AppDir, "run-host.cmd");
            File.WriteAllText(launcher, "@echo off\r\n\"%~dp0runtime\\node.exe\" \"%~dp0host\\host.js\"\r\n", new ASCIIEncoding());
            string manifest = Path.Combine(AppDir, HostName + ".json");
            File.WriteAllText(manifest, BuildHostManifest(launcher), new UTF8Encoding(false));
            foreach (string key in HostKeys)
            {
                using (RegistryKey created = Registry.CurrentUser.CreateSubKey(key)) created.SetValue("", manifest);
            }

            progress(95, "Adding it to Windows");
            RegisterUninstaller();
            progress(100, "Done");
        }

        public static void Uninstall()
        {
            StopRunningHosts();
            foreach (string key in HostKeys) Registry.CurrentUser.DeleteSubKeyTree(key, false);
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);

            if (Application.ExecutablePath.StartsWith(AppDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                // An exe can't delete itself, so the folder goes away just after this one exits.
                ProcessStartInfo cleanup = new ProcessStartInfo("cmd.exe", "/d /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + AppDir + "\"");
                cleanup.CreateNoWindow = true;
                cleanup.UseShellExecute = false;
                cleanup.WorkingDirectory = Path.GetTempPath();
                Process.Start(cleanup);
            }
            else if (Directory.Exists(AppDir))
            {
                Directory.Delete(AppDir, true);
            }
        }

        static void ExtractPayload(Action<int> progress)
        {
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (string folder in new[] { "extension", "host", "runtime" })
                {
                    string old = Path.Combine(AppDir, folder);
                    if (Directory.Exists(old)) Directory.Delete(old, true);
                }

                long total = archive.Entries.Sum(entry => entry.Length);
                long done = 0;
                string root = Path.GetFullPath(AppDir) + Path.DirectorySeparatorChar;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string target = Path.GetFullPath(Path.Combine(AppDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream source = entry.Open())
                    using (FileStream output = File.Create(target))
                    {
                        source.CopyTo(output);
                    }
                    done += entry.Length;
                    progress(total == 0 ? 100 : (int)(done * 100 / total));
                }
            }
        }

        static string BuildHostManifest(string launcher)
        {
            return "{\n  \"name\": \"" + HostName + "\",\n  \"description\": \"" + AppName + " native host\",\n  \"path\": \""
                + launcher.Replace("\\", "\\\\") + "\",\n  \"type\": \"stdio\",\n  \"allowed_origins\": [\"chrome-extension://" + ExtensionId + "/\"]\n}\n";
        }

        // The version the extension carries, so Installed apps always shows what was really installed.
        static string InstalledVersion()
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(ExtensionDir, "manifest.json"));
                Match match = Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (match.Success) return match.Groups[1].Value;
            }
            catch (IOException)
            {
                // The files were just copied, so this should not happen. The entry then has no version.
            }
            return "";
        }

        static void RegisterUninstaller()
        {
            string current = Application.ExecutablePath;
            string copy = Path.Combine(AppDir, "uninstall.exe");
            if (!string.Equals(Path.GetFullPath(current), Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(current, copy, true);
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", AppName);
                key.SetValue("DisplayIcon", copy);
                key.SetValue("DisplayVersion", InstalledVersion());
                key.SetValue("InstallLocation", AppDir);
                key.SetValue("UninstallString", "\"" + copy + "\" --uninstall");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        static void StopRunningHosts()
        {
            string runtime = Path.Combine(AppDir, "runtime");
            foreach (Process process in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (process.MainModule.FileName.StartsWith(runtime, StringComparison.OrdinalIgnoreCase))
                    {
                        process.Kill();
                        process.WaitForExit(3000);
                    }
                }
                catch (Exception)
                {
                    // The process is not ours to inspect, or it has already exited.
                }
            }
        }

        public static List<Browser> FindBrowsers()
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] roots = { programFiles, programFilesX86, LocalAppData };
            var known = new[]
            {
                new { Name = "Brave", Relative = @"BraveSoftware\Brave-Browser\Application\brave.exe", Scheme = "brave", Data = @"BraveSoftware\Brave-Browser\User Data" },
                new { Name = "Chrome", Relative = @"Google\Chrome\Application\chrome.exe", Scheme = "chrome", Data = @"Google\Chrome\User Data" },
                new { Name = "Edge", Relative = @"Microsoft\Edge\Application\msedge.exe", Scheme = "edge", Data = @"Microsoft\Edge\User Data" },
                new { Name = "Chromium", Relative = @"Chromium\Application\chrome.exe", Scheme = "chrome", Data = @"Chromium\User Data" },
            };
            List<Browser> found = new List<Browser>();
            foreach (var item in known)
            {
                foreach (string root in roots)
                {
                    string executable = Path.Combine(root, item.Relative);
                    if (!File.Exists(executable)) continue;
                    found.Add(new Browser
                    {
                        Name = item.Name,
                        Executable = executable,
                        ExtensionsUrl = item.Scheme + "://extensions/",
                        UserData = Path.Combine(LocalAppData, item.Data),
                    });
                    break;
                }
            }
            return found;
        }

        public static bool IsExtensionLoaded(Browser browser)
        {
            if (!Directory.Exists(browser.UserData)) return false;
            foreach (string profile in Directory.GetDirectories(browser.UserData))
            {
                string name = Path.GetFileName(profile);
                if (name != "Default" && !name.StartsWith("Profile ", StringComparison.Ordinal)) continue;
                string preferences = Path.Combine(profile, "Secure Preferences");
                if (!File.Exists(preferences)) continue;
                try
                {
                    // The browser keeps this file open, so it has to be read in shared mode.
                    using (FileStream stream = new FileStream(preferences, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamReader reader = new StreamReader(stream))
                    {
                        if (reader.ReadToEnd().Contains(ExtensionId)) return true;
                    }
                }
                catch (IOException)
                {
                    // The browser is rewriting the file; the next check will see it.
                }
            }
            return false;
        }
    }

    static class Theme
    {
        public static readonly Color Background = Color.FromArgb(21, 21, 23);
        public static readonly Color Surface = Color.FromArgb(38, 38, 41);
        public static readonly Color Border = Color.FromArgb(58, 58, 62);
        public static readonly Color Text = Color.FromArgb(249, 250, 251);
        public static readonly Color TextSecondary = Color.FromArgb(207, 211, 214);
        public static readonly Color Caption = Color.FromArgb(150, 154, 161);
        public static readonly Color Brand = Color.FromArgb(86, 134, 254);
        public static readonly Color BrandHover = Color.FromArgb(108, 150, 255);
        public static readonly Color Success = Color.FromArgb(34, 197, 94);
        public static readonly Color Danger = Color.FromArgb(242, 90, 90);
        public static readonly Color DangerSurface = Color.FromArgb(58, 34, 36);

        public static float Scale = 1f;

        public static int S(int value) { return (int)Math.Round(value * Scale); }

        public static Font Font(int size, bool semibold = false)
        {
            return new Font(semibold ? "Segoe UI Semibold" : "Segoe UI", size * Scale, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        // The color behind a control's rounded corners.
        public static Color BehindColor(Control control)
        {
            Card card = control.Parent as Card;
            if (card != null) return card.Fill;
            return control.Parent != null ? control.Parent.BackColor : Background;
        }

        public static GraphicsPath Rounded(Rectangle area, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = radius * 2;
            path.AddArc(area.X, area.Y, diameter, diameter, 180, 90);
            path.AddArc(area.Right - diameter, area.Y, diameter, diameter, 270, 90);
            path.AddArc(area.Right - diameter, area.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(area.X, area.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    class FlatButton : Control
    {
        public enum Kinds { Primary, Secondary, Quiet }

        public Kinds Kind = Kinds.Secondary;
        public bool Selected;
        bool hovering;

        public FlatButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Cursor = Cursors.Hand;
            Font = Theme.Font(14, true);
            BackColor = Theme.Background;
            TabStop = true;
        }

        protected override void OnMouseEnter(EventArgs e) { hovering = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovering = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) OnClick(EventArgs.Empty);
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.BehindColor(this));
            Rectangle area = new Rectangle(0, 0, Width - 1, Height - 1);
            Color text = Theme.Text;
            using (GraphicsPath path = Theme.Rounded(area, Theme.S(10)))
            {
                if (Kind == Kinds.Primary)
                {
                    using (Brush fill = new SolidBrush(hovering ? Theme.BrandHover : Theme.Brand)) g.FillPath(fill, path);
                    text = Color.White;
                }
                else if (Kind == Kinds.Secondary)
                {
                    if (hovering || Selected)
                    {
                        using (Brush fill = new SolidBrush(Theme.Surface)) g.FillPath(fill, path);
                    }
                    using (Pen line = new Pen(Selected ? Theme.Brand : Theme.Border)) g.DrawPath(line, path);
                    text = Theme.TextSecondary;
                }
                else
                {
                    text = hovering ? Theme.Text : Theme.Caption;
                }
                if (Focused && Kind != Kinds.Quiet)
                {
                    using (Pen ring = new Pen(Color.FromArgb(160, Color.White))) g.DrawPath(ring, path);
                }
            }
            TextRenderer.DrawText(g, Text, Font, area, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    class Card : Panel
    {
        public Color Fill = Theme.Surface;
        public Color Line = Theme.Border;

        public Card()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Theme.BehindColor(this));
            using (GraphicsPath path = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Theme.S(12)))
            using (Brush brush = new SolidBrush(Fill))
            using (Pen pen = new Pen(Line))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    class ProgressLine : Control
    {
        int percent;
        public int Percent { get { return percent; } set { percent = value; Invalidate(); } }

        public ProgressLine()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Theme.Background);
            int radius = Height / 2 - 1;
            using (GraphicsPath track = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), radius))
            using (Brush brush = new SolidBrush(Theme.Surface)) e.Graphics.FillPath(brush, track);
            int width = Math.Max(Height, (Width - 1) * percent / 100);
            using (GraphicsPath done = Theme.Rounded(new Rectangle(0, 0, width, Height - 1), radius))
            using (Brush brush = new SolidBrush(Theme.Brand)) e.Graphics.FillPath(brush, done);
        }
    }

    // Draws the app mark, or a success mark, without any image files.
    class Mark : Control
    {
        public bool Success;

        public Mark()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.BehindColor(this));
            float size = Width;
            using (GraphicsPath path = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Width / 4))
            using (Brush brush = new SolidBrush(Success ? Theme.Success : Theme.Brand))
            using (Pen pen = new Pen(Color.White, size * 0.09f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                g.FillPath(brush, path);
                if (Success)
                {
                    g.DrawLines(pen, new[] { new PointF(size * .27f, size * .52f), new PointF(size * .44f, size * .69f), new PointF(size * .74f, size * .33f) });
                }
                else
                {
                    g.DrawLines(pen, new[] { new PointF(size * .27f, size * .31f), new PointF(size * .46f, size * .5f), new PointF(size * .27f, size * .69f) });
                    g.DrawLine(pen, size * .52f, size * .69f, size * .75f, size * .69f);
                }
            }
        }
    }

    class StepBadge : Control
    {
        public StepBadge()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Font = Theme.Font(13, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Theme.BehindColor(this));
            using (Brush brush = new SolidBrush(Theme.Brand)) e.Graphics.FillEllipse(brush, 0, 0, Width - 1, Height - 1);
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    class WizardForm : Form
    {
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        const int ContentWidth = 556;
        const int PageMargin = 32;

        readonly Panel host;
        readonly List<Browser> browsers;
        readonly Timer watcher = new Timer();
        Browser selected;
        bool installing;
        bool removeFolderOnClose;

        // Page parts that change while the wizard runs.
        ProgressLine progress;
        Label progressText;
        Label waitingText;
        readonly List<FlatButton> browserChips = new List<FlatButton>();
        FlatButton openExtensions;
        FlatButton copyPath;

        public WizardForm(bool uninstall)
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) Theme.Scale = g.DpiX / 96f;
            browsers = Installer.FindBrowsers();
            selected = browsers.FirstOrDefault();

            Text = Installer.AppName + " Setup";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Background;
            ClientSize = new Size(Theme.S(620), Theme.S(460));
            Font = Theme.Font(14);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            host = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Background };
            Controls.Add(host);

            watcher.Interval = 1500;
            watcher.Tick += delegate { CheckExtension(); };

            if (uninstall) ShowUninstallPage(); else ShowWelcomePage();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (installing) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            watcher.Stop();
            if (removeFolderOnClose) Installer.Uninstall();
            base.OnFormClosed(e);
        }

        // ---- Building blocks -----------------------------------------------------------------

        void StartPage()
        {
            watcher.Stop();
            host.Controls.Clear();
        }

        Label AddText(Control parent, string text, int x, int y, int width, int height, int size, Color color, bool semibold = false)
        {
            Label label = new Label
            {
                Text = text,
                Location = new Point(Theme.S(x), Theme.S(y)),
                Size = new Size(Theme.S(width), Theme.S(height)),
                Font = Theme.Font(size, semibold),
                ForeColor = color,
                BackColor = parent is Card ? ((Card)parent).Fill : Theme.Background,
                AutoSize = false,
                UseMnemonic = false,
            };
            parent.Controls.Add(label);
            return label;
        }

        FlatButton AddButton(Control parent, string text, int x, int y, int width, FlatButton.Kinds kind, Action action, int height = 40)
        {
            FlatButton button = new FlatButton
            {
                Text = text,
                Kind = kind,
                Location = new Point(Theme.S(x), Theme.S(y)),
                Size = new Size(Theme.S(width), Theme.S(height)),
            };
            button.Click += delegate { action(); };
            parent.Controls.Add(button);
            return button;
        }

        void AddHeader(string title, string subtitle, bool success = false)
        {
            Mark mark = new Mark { Success = success, Location = new Point(Theme.S(PageMargin), Theme.S(32)), Size = new Size(Theme.S(44), Theme.S(44)) };
            host.Controls.Add(mark);
            AddText(host, title, PageMargin + 58, 28, ContentWidth - 58, 30, 21, Theme.Text, true);
            AddText(host, subtitle, PageMargin + 58, 58, ContentWidth - 58, 22, 14, Theme.Caption);
        }

        // ---- Pages ---------------------------------------------------------------------------

        void ShowWelcomePage()
        {
            StartPage();
            AddHeader(Installer.AppName, "Let DeepSeek work on your computer");

            AddText(host, "Once installed, the DeepSeek web chat can read and change your files, search them and run commands. Every change waits for your approval unless you turn on Bypass.", PageMargin, 104, ContentWidth, 62, 15, Theme.TextSecondary);

            Card facts = new Card { Location = new Point(Theme.S(PageMargin), Theme.S(176)), Size = new Size(Theme.S(ContentWidth), Theme.S(124)) };
            host.Controls.Add(facts);
            AddText(facts, "No admin rights and nothing else to install", 18, 16, ContentWidth - 36, 22, 14, Theme.Text);
            AddText(facts, "Installs for your Windows user only, and you can remove it from Installed apps.", 18, 38, ContentWidth - 36, 20, 13, Theme.Caption);
            AddText(facts, "Your data goes to DeepSeek", 18, 68, ContentWidth - 36, 22, 14, Theme.Text);
            AddText(facts, "Whatever the model reads or a command prints is sent to DeepSeek's servers.", 18, 90, ContentWidth - 36, 20, 13, Theme.Caption);

            AddButton(host, "Cancel", 620 - PageMargin - 150 - 12 - 110, 396, 110, FlatButton.Kinds.Secondary, Close);
            FlatButton install = AddButton(host, "Install", 620 - PageMargin - 150, 396, 150, FlatButton.Kinds.Primary, StartInstall);
            ActiveControl = install;
        }

        void ShowProgressPage()
        {
            StartPage();
            AddHeader("Installing", "This takes a few seconds");
            progress = new ProgressLine { Location = new Point(Theme.S(PageMargin), Theme.S(196)), Size = new Size(Theme.S(ContentWidth), Theme.S(8)) };
            host.Controls.Add(progress);
            progressText = AddText(host, "Getting ready", PageMargin, 216, ContentWidth, 22, 14, Theme.Caption);
        }

        async void StartInstall()
        {
            installing = true;
            ShowProgressPage();
            Exception failure = null;
            Action<int, string> report = delegate(int percent, string message)
            {
                BeginInvoke((Action)delegate
                {
                    progress.Percent = percent;
                    progressText.Text = message;
                });
            };
            await Task.Run(delegate
            {
                try { Installer.Install(report); }
                catch (Exception error) { failure = error; }
            });
            installing = false;
            if (failure != null) ShowFailurePage(failure.Message);
            else if (browsers.Any(Installer.IsExtensionLoaded)) ShowDonePage(true);
            else ShowBrowserPage();
        }

        void ShowFailurePage(string message)
        {
            StartPage();
            AddHeader("That didn't work", "Nothing is broken. You can try again.");
            Card card = new Card { Location = new Point(Theme.S(PageMargin), Theme.S(120)), Size = new Size(Theme.S(ContentWidth), Theme.S(150)), Fill = Theme.DangerSurface, Line = Theme.DangerSurface };
            host.Controls.Add(card);
            AddText(card, message, 16, 14, ContentWidth - 32, 122, 14, Theme.TextSecondary);
            AddText(host, "If your browser is using the tool, close it and try again.", PageMargin, 284, ContentWidth, 22, 14, Theme.Caption);
            AddButton(host, "Close", 620 - PageMargin - 150 - 12 - 110, 396, 110, FlatButton.Kinds.Secondary, Close);
            AddButton(host, "Try again", 620 - PageMargin - 150, 396, 150, FlatButton.Kinds.Primary, StartInstall);
        }

        void ShowBrowserPage()
        {
            StartPage();
            AddHeader("One last step", "Browsers only let you add this kind of extension yourself");
            browserChips.Clear();

            int top = 96;
            if (browsers.Count > 1)
            {
                int x = PageMargin;
                foreach (Browser browser in browsers)
                {
                    Browser current = browser;
                    FlatButton chip = AddButton(host, browser.Name, x, top, 96, FlatButton.Kinds.Secondary, delegate { SelectBrowser(current); }, 32);
                    chip.Tag = browser;
                    chip.Font = Theme.Font(13, true);
                    browserChips.Add(chip);
                    x += 104;
                }
                top += 44;
            }

            Card steps = new Card { Location = new Point(Theme.S(PageMargin), Theme.S(top)), Size = new Size(Theme.S(ContentWidth), Theme.S(196)) };
            host.Controls.Add(steps);
            AddStep(steps, 1, "Open the extensions page and turn on Developer mode", 14);
            AddStep(steps, 2, "Click \"Load unpacked\"", 52);
            AddStep(steps, 3, "Paste this folder in the window that opens, then click Select Folder", 90);

            Card pathBox = new Card { Location = new Point(Theme.S(50), Theme.S(126)), Size = new Size(Theme.S(ContentWidth - 68), Theme.S(50)), Fill = Theme.Background };
            steps.Controls.Add(pathBox);
            Label path = AddText(pathBox, "", 12, 14, ContentWidth - 68 - 104, 22, 12, Theme.TextSecondary);
            path.Font = new Font("Consolas", 12 * Theme.Scale, FontStyle.Regular, GraphicsUnit.Pixel);
            path.Text = ShortenPath(Installer.ExtensionDir, path.Font, path.Width);
            copyPath = AddButton(pathBox, "Copied", ContentWidth - 68 - 86, 9, 76, FlatButton.Kinds.Secondary, CopyPath, 32);
            copyPath.Font = Theme.Font(12, true);
            copyPath.BackColor = Theme.Background;
            CopyPath();

            waitingText = AddText(host, "Waiting for the extension to appear…", PageMargin, top + 208, ContentWidth, 22, 13, Theme.Caption);

            AddButton(host, "Skip", PageMargin - 10, 396, 70, FlatButton.Kinds.Quiet, delegate { ShowDonePage(false); });
            openExtensions = AddButton(host, "Open extensions page", 620 - PageMargin - 210, 396, 210, FlatButton.Kinds.Primary, OpenExtensionsPage);
            if (browsers.Count == 0)
            {
                waitingText.Text = "No supported browser found. Install Brave, Chrome or Edge, then come back.";
                openExtensions.Enabled = false;
            }
            else
            {
                SelectBrowser(selected);
            }
            ActiveControl = openExtensions;
            watcher.Start();
        }

        // Keeps the end of the path visible, since that is the part people check.
        static string ShortenPath(string path, Font font, int width)
        {
            string shown = string.Copy(path);
            TextRenderer.MeasureText(shown, font, new Size(width, 0), TextFormatFlags.PathEllipsis | TextFormatFlags.ModifyString);
            int end = shown.IndexOf('\0');
            return end >= 0 ? shown.Substring(0, end) : shown;
        }

        void AddStep(Control parent, int number, string text, int y)
        {
            parent.Controls.Add(new StepBadge
            {
                Text = number.ToString(),
                Location = new Point(Theme.S(18), Theme.S(y)),
                Size = new Size(Theme.S(24), Theme.S(24)),
            });
            AddText(parent, text, 50, y + 2, ContentWidth - 68, 24, 14, Theme.Text);
        }

        void SelectBrowser(Browser browser)
        {
            selected = browser;
            foreach (FlatButton chip in browserChips)
            {
                chip.Selected = chip.Tag == browser;
                chip.Invalidate();
            }
            if (openExtensions != null) openExtensions.Text = "Open " + browser.Name + " extensions";
        }

        void CopyPath()
        {
            try { Clipboard.SetText(Installer.ExtensionDir); } catch (ExternalException) { }
            if (copyPath != null) copyPath.Text = "Copied";
        }

        void OpenExtensionsPage()
        {
            if (selected == null) return;
            CopyPath();
            try
            {
                Process.Start(selected.Executable, selected.ExtensionsUrl);
                waitingText.Text = "The folder is copied. Press Ctrl+V in the folder window. Waiting for the extension…";
            }
            catch (Exception error)
            {
                waitingText.Text = "Couldn't open " + selected.Name + ": " + error.Message;
            }
        }

        void CheckExtension()
        {
            foreach (Browser browser in browsers)
            {
                if (Installer.IsExtensionLoaded(browser))
                {
                    selected = browser;
                    ShowDonePage(true);
                    return;
                }
            }
        }

        void ShowDonePage(bool extensionFound)
        {
            StartPage();
            AddHeader("You're all set", extensionFound ? "The tool is installed and the extension is in your browser" : "The tool is installed", true);

            Card card = new Card { Location = new Point(Theme.S(PageMargin), Theme.S(112)), Size = new Size(Theme.S(ContentWidth), Theme.S(176)) };
            host.Controls.Add(card);
            AddText(card, "In the DeepSeek chat", 18, 14, ContentWidth - 36, 22, 14, Theme.Text, true);
            AddText(card, "Shell · Connected at the top right means it's ready. If a page was already open, reload it.", 18, 40, ContentWidth - 36, 42, 14, Theme.TextSecondary);
            AddText(card, "The folder button next to DeepThink picks the working directory.", 18, 86, ContentWidth - 36, 22, 14, Theme.TextSecondary);
            AddText(card, "Manual asks before every change. Bypass runs everything without asking: use it only in chats you trust.", 18, 112, ContentWidth - 36, 42, 14, Theme.TextSecondary);

            if (!extensionFound)
            {
                AddText(host, "You still need to add the extension. Run this setup again to see how.", PageMargin, 300, ContentWidth, 22, 13, Theme.Caption);
            }

            AddButton(host, "Close", 620 - PageMargin - 170 - 12 - 110, 396, 110, FlatButton.Kinds.Secondary, Close);
            if (selected != null)
            {
                FlatButton open = AddButton(host, "Open DeepSeek", 620 - PageMargin - 170, 396, 170, FlatButton.Kinds.Primary, OpenDeepSeek);
                ActiveControl = open;
            }
        }

        void OpenDeepSeek()
        {
            try { Process.Start(selected.Executable, "https://chat.deepseek.com/"); } catch (Exception) { }
            Close();
        }

        void ShowUninstallPage()
        {
            StartPage();
            AddHeader("Remove " + Installer.AppName, "DeepSeek will no longer be able to work on your computer");
            AddText(host, "This removes the program and its link to your browsers. Files that DeepSeek created or changed stay where they are.", PageMargin, 112, ContentWidth, 44, 15, Theme.TextSecondary);
            AddButton(host, "Cancel", 620 - PageMargin - 150 - 12 - 110, 396, 110, FlatButton.Kinds.Secondary, Close);
            AddButton(host, "Remove", 620 - PageMargin - 150, 396, 150, FlatButton.Kinds.Primary, ShowRemovedPage);
        }

        void ShowRemovedPage()
        {
            removeFolderOnClose = true;
            StartPage();
            AddHeader("Removed", Installer.AppName + " is gone from your computer", true);
            AddText(host, "To finish, open your browser's extensions page and remove " + Installer.AppName + ". It can't remove itself.", PageMargin, 112, ContentWidth, 44, 15, Theme.TextSecondary);
            FlatButton close = AddButton(host, "Close", 620 - PageMargin - 150, 396, 150, FlatButton.Kinds.Primary, Close);
            ActiveControl = close;
        }

        // ---- Off-screen rendering, for reviewing the design without opening a window -----------

        public static void RenderPages(string folder)
        {
            Directory.CreateDirectory(folder);
            WizardForm form = new WizardForm(false);
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-5000, -5000);
            form.ShowInTaskbar = false;
            form.Show();

            Action<string> save = delegate(string name)
            {
                form.watcher.Stop();
                form.ActiveControl = null;
                Application.DoEvents();
                using (Bitmap image = new Bitmap(form.host.Width, form.host.Height))
                {
                    form.host.DrawToBitmap(image, new Rectangle(0, 0, image.Width, image.Height));
                    image.Save(Path.Combine(folder, name + ".png"));
                }
            };

            save("1-welcome");
            form.ShowProgressPage();
            form.progress.Percent = 60;
            form.progressText.Text = "Copying files";
            save("2-progress");
            form.ShowBrowserPage();
            save("3-browser");
            form.ShowDonePage(true);
            save("4-done");
            form.ShowFailurePage("Access to the path 'node.exe' is denied.");
            save("5-failure");
            form.ShowUninstallPage();
            save("6-uninstall");
            form.ShowRemovedPage();
            form.removeFolderOnClose = false;
            save("7-removed");
            form.Dispose();
        }
    }
}
