# 끌어 놓기 재현 도우미 (.github/workflows/droptest-rs.yml): 탐색기처럼 OLE(DoDragDrop)로 파일을 끌어 화면의 한 점에 놓는다.
#   작은 창의 글자를 마우스로 누르면(SendInput) 그 창이 파일 끌기를 시작하고, 커서를 목표로 옮겨 잠깐 머문 뒤 뗀다.
#   놓을 때마다 받는 쪽이 돌려준 결과(Copy = 받음, None = 무시)를 찍는다.
param([string]$File, [int]$X, [int]$Y, [int]$Times = 2)
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Threading; using System.Windows.Forms;
using System.Collections.Specialized; using System.Text;
public static class DropDriver {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static string Run(string file, int tx, int ty, int times) {
    SetProcessDPIAware();
    var log = new StringBuilder();
    var form = new Form { StartPosition = FormStartPosition.Manual, Location = new Point(30, 30), Size = new Size(260, 150), TopMost = true, Text = "drag source" };
    var lbl = new Label { Text = "DRAG ME", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 16) };
    form.Controls.Add(lbl);
    int n = 0;
    var t0 = DateTime.Now;
    lbl.MouseDown += (s, e) => {
      var data = new DataObject();
      var list = new StringCollection(); list.Add(file); data.SetFileDropList(list);
      var started = (DateTime.Now - t0).TotalSeconds;
      var eff = lbl.DoDragDrop(data, DragDropEffects.Copy);
      log.AppendLine(string.Format("drag {0}: started {1:F1}s, result {2}", ++n, started, eff));
    };
    form.Shown += (s, e) => {
      var t = new Thread(() => {
        Point src = (Point)form.Invoke((Func<Point>)(() => lbl.PointToScreen(new Point(lbl.Width / 2, lbl.Height / 2))));
        for (int i = 0; i < times; i++) {
          Thread.Sleep(2000);
          SetCursorPos(src.X, src.Y); Thread.Sleep(200);
          mouse_event(0x2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(300);
          for (int k = 1; k <= 30; k++) { SetCursorPos(src.X + (tx - src.X) * k / 30, src.Y + (ty - src.Y) * k / 30); Thread.Sleep(30); }
          for (int k = 0; k < 24; k++) { SetCursorPos(tx + (k % 3), ty + (k % 2)); Thread.Sleep(50); }
          mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
          Thread.Sleep(2500);
        }
        form.Invoke((Action)(() => form.Close()));
      });
      t.IsBackground = true;
      t.Start();
    };
    Application.Run(form);
    return log.ToString();
  }
}
'@
[DropDriver]::Run($File, $X, $Y, $Times)
