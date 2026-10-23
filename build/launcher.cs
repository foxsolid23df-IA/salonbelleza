using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

class Launcher
{
    static string BaseDir()
    {
        return AppDomain.CurrentDomain.BaseDirectory;
    }

    static int PortFromFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return 0;
            int p;
            if (int.TryParse(File.ReadAllText(path).Trim(), out p) && p > 0 && p < 65536) return p;
        }
        catch { }
        return 0;
    }

    static int PreferredPort()
    {
        string root = BaseDir();
        int p = PortFromFile(Path.Combine(root, "app", "data", "port.txt"));
        if (p > 0) return p;
        try
        {
            string env = Path.Combine(root, "app", ".env");
            if (File.Exists(env))
            {
                Match m = Regex.Match(File.ReadAllText(env), @"(?m)^\s*PORT\s*=\s*(\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
        }
        catch { }
        return 3000;
    }

    static bool Up(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static int FindPort()
    {
        int preferred = PreferredPort();
        if (Up(preferred)) return preferred;
        for (int p = 3000; p <= 3010; p++)
        {
            if (p != preferred && Up(p)) return p;
        }
        return 0;
    }

    static void StartApp()
    {
        string root = BaseDir();
        string exe = Path.Combine(root, "runtime", "node.exe");
        string app = Path.Combine(root, "app", "server.js");
        if (!File.Exists(exe) || !File.Exists(app)) return;
        ProcessStartInfo psi = new ProcessStartInfo(exe, "\"" + app + "\"");
        psi.WorkingDirectory = Path.Combine(root, "app");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try { Process.Start(psi); } catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        bool checkOnly = false;
        if (args != null)
        {
            foreach (string a in args)
            {
                if (string.Equals(a, "--check", StringComparison.OrdinalIgnoreCase)) checkOnly = true;
            }
        }
        int port = FindPort();
        if (port == 0)
        {
            StartApp();
            for (int i = 0; i < 60 && port == 0; i++)
            {
                Thread.Sleep(250);
                port = FindPort();
            }
        }
        if (port == 0)
        {
            Environment.ExitCode = 1;
            MessageBox.Show(
                "No se pudo iniciar Salón Suite.\n\nRevisa que el servicio \"Salón Suite\" esté iniciado en Servicios de Windows, o ejecuta la aplicación como administrador.",
                "Salón Suite",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }
        string url = "http://127.0.0.1:" + port + "/";
        if (checkOnly) return;
        try { Process.Start(url); }
        catch { try { Process.Start("explorer.exe", url); } catch { } }
    }
}
