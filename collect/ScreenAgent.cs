using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Shiye
{
    public static class RegionMath
    {
        public const int Minimum = 24;
        public static Rectangle FromPoints(Point a, Point b)
        {
            return Rectangle.FromLTRB(Math.Min(a.X,b.X), Math.Min(a.Y,b.Y), Math.Max(a.X,b.X), Math.Max(a.Y,b.Y));
        }
        private static int Clamp(int value, int low, int high) { return Math.Max(low, Math.Min(high,value)); }
        public static Rectangle Move(Rectangle r, int dx, int dy, Rectangle bounds)
        {
            return new Rectangle(Clamp(r.X+dx,bounds.Left,bounds.Right-r.Width), Clamp(r.Y+dy,bounds.Top,bounds.Bottom-r.Height),r.Width,r.Height);
        }
        public static Rectangle Resize(Rectangle r, string edge, Point p, Rectangle bounds)
        {
            int l=r.Left, t=r.Top, right=r.Right, bottom=r.Bottom;
            if(edge.Contains("W")) l=Clamp(p.X,bounds.Left,right-Minimum);
            if(edge.Contains("E")) right=Clamp(p.X,l+Minimum,bounds.Right);
            if(edge.Contains("N")) t=Clamp(p.Y,bounds.Top,bottom-Minimum);
            if(edge.Contains("S")) bottom=Clamp(p.Y,t+Minimum,bounds.Bottom);
            return Rectangle.FromLTRB(l,t,right,bottom);
        }
        public static bool IsValid(Rectangle r, Rectangle bounds)
        {
            return r.Width>=Minimum && r.Height>=Minimum && (long)r.Width*r.Height<=32000000 && bounds.Contains(r);
        }
    }

    public sealed class CaptureState
    {
        public Rectangle Region { get; set; }
        public bool Selecting { get; private set; }
        public bool CanCapture { get { return !Selecting && Region.Width>=RegionMath.Minimum && Region.Height>=RegionMath.Minimum; } }
        public void BeginSelection() { Selecting=true; }
        public void EndSelection(Rectangle? result)
        {
            if(result.HasValue && result.Value.Width>=RegionMath.Minimum && result.Value.Height>=RegionMath.Minimum && (long)result.Value.Width*result.Value.Height<=32000000)
                Region=result.Value;
            Selecting=false;
        }
    }

    public class RegionSelector : Form
    {
        private readonly Bitmap snapshot;
        private readonly Rectangle desktop;
        private Rectangle selection,beforeDrag;
        private Point anchor;
        private string dragging;
        private readonly Font uiFont=new Font("Microsoft YaHei UI",10f);
        private readonly Font smallFont=new Font("Microsoft YaHei UI",9f);
        private readonly Color accent=Color.FromArgb(70,156,255);
        private Rectangle confirmButton,cancelButton;
        public Rectangle SelectedRegion { get { return new Rectangle(selection.X+desktop.X,selection.Y+desktop.Y,selection.Width,selection.Height); } }

        // The selector owns and disposes the supplied snapshot.
        public RegionSelector(Bitmap background, Rectangle screenBounds, Rectangle previous, bool captureLive=false)
        {
            snapshot=background; desktop=screenBounds;
            AutoScaleMode=AutoScaleMode.None;
            FormBorderStyle=FormBorderStyle.None; StartPosition=FormStartPosition.Manual;
            Bounds=screenBounds; ShowInTaskbar=false; TopMost=true; KeyPreview=true;
            DoubleBuffered=true; Text="拾页 · 选择截图区域"; Cursor=Cursors.Cross;
            if(RegionMath.IsValid(previous,screenBounds))
                selection=new Rectangle(previous.X-screenBounds.X,previous.Y-screenBounds.Y,previous.Width,previous.Height);
            if(captureLive) Opacity=0;
            Shown+=async delegate {
                Activate(); Focus();
                if(!captureLive) return;
                // Activate first, so the Windows tray overflow closes before we freeze the desktop.
                await Task.Delay(180);
                if(IsDisposed || Disposing) return;
                try
                {
                    using(var graphics=Graphics.FromImage(snapshot)) graphics.CopyFromScreen(desktop.Location,Point.Empty,desktop.Size);
                    Opacity=1; Invalidate();
                }
                catch(Exception)
                {
                    DialogResult=DialogResult.Cancel; Close();
                }
            };
        }
        private Point Limit(Point p)
        {
            return new Point(Math.Max(0,Math.Min(ClientSize.Width,p.X)),Math.Max(0,Math.Min(ClientSize.Height,p.Y)));
        }
        private Point[] Handles()
        {
            int l=selection.Left,r=selection.Right,t=selection.Top,b=selection.Bottom,x=l+selection.Width/2,y=t+selection.Height/2;
            return new Point[] {new Point(l,t),new Point(x,t),new Point(r,t),new Point(r,y),new Point(r,b),new Point(x,b),new Point(l,b),new Point(l,y)};
        }
        private string Hit(Point p)
        {
            if(selection.Width<RegionMath.Minimum || selection.Height<RegionMath.Minimum) return "NEW";
            var names=new string[] {"NW","N","NE","E","SE","S","SW","W"};
            var handles=Handles();
            for(int i=0;i<handles.Length;i++)
                if(Math.Abs(p.X-handles[i].X)<=8 && Math.Abs(p.Y-handles[i].Y)<=8) return names[i];
            return selection.Contains(p)?"MOVE":"NEW";
        }
        private void Accept()
        {
            if(!RegionMath.IsValid(SelectedRegion,desktop)) return;
            DialogResult=DialogResult.OK; Close();
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if(e.Button==MouseButtons.Right) { DialogResult=DialogResult.Cancel; Close(); return; }
            if(e.Button!=MouseButtons.Left) return;
            if(confirmButton.Contains(e.Location)) { Accept(); return; }
            if(cancelButton.Contains(e.Location)) { DialogResult=DialogResult.Cancel; Close(); return; }
            anchor=Limit(e.Location); beforeDrag=selection; dragging=Hit(e.Location); Capture=true;
            if(dragging=="NEW") selection=Rectangle.Empty;
            Invalidate();
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            Point p=Limit(e.Location);
            if(dragging!=null)
            {
                if(dragging=="NEW") selection=RegionMath.FromPoints(anchor,p);
                else if(dragging=="MOVE") selection=RegionMath.Move(beforeDrag,p.X-anchor.X,p.Y-anchor.Y,ClientRectangle);
                else selection=RegionMath.Resize(beforeDrag,dragging,p,ClientRectangle);
                Invalidate();
            }
            string hit=dragging??Hit(e.Location);
            Cursor=hit=="MOVE"?Cursors.SizeAll:hit=="NW"||hit=="SE"?Cursors.SizeNWSE:
                hit=="NE"||hit=="SW"?Cursors.SizeNESW:hit=="N"||hit=="S"?Cursors.SizeNS:
                hit=="W"||hit=="E"?Cursors.SizeWE:Cursors.Cross;
            if(dragging==null && (confirmButton.Contains(e.Location)||cancelButton.Contains(e.Location))) Cursor=Cursors.Hand;
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if(e.Button!=MouseButtons.Left) return;
            dragging=null; Capture=false; Invalidate();
        }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if(keyData==Keys.Escape) { DialogResult=DialogResult.Cancel; Close(); return true; }
            if(keyData==Keys.Enter) { Accept(); return true; }
            int step=(keyData&Keys.Shift)!=0?10:1;
            Keys key=keyData&Keys.KeyCode;
            if(key==Keys.Left||key==Keys.Right||key==Keys.Up||key==Keys.Down)
            {
                selection=RegionMath.Move(selection,key==Keys.Left?-step:key==Keys.Right?step:0,key==Keys.Up?-step:key==Keys.Down?step:0,ClientRectangle);
                Invalidate(); return true;
            }
            return base.ProcessCmdKey(ref msg,keyData);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g=e.Graphics;
            g.DrawImageUnscaled(snapshot,0,0);
            using(var shade=new SolidBrush(Color.FromArgb(155,9,14,24))) g.FillRectangle(shade,ClientRectangle);
            confirmButton=cancelButton=Rectangle.Empty;
            if(selection.Width>0 && selection.Height>0)
            {
                g.DrawImage(snapshot,selection,selection,GraphicsUnit.Pixel);
                using(var pen=new Pen(accent,2)) g.DrawRectangle(pen,selection);
                foreach(Point p in Handles())
                {
                    using(var brush=new SolidBrush(Color.White)) g.FillRectangle(brush,p.X-4,p.Y-4,8,8);
                    using(var pen=new Pen(accent)) g.DrawRectangle(pen,p.X-4,p.Y-4,8,8);
                }
                string size=String.Format("{0} × {1} px    X {2}   Y {3}",selection.Width,selection.Height,SelectedRegion.X,SelectedRegion.Y);
                Size labelSize=TextRenderer.MeasureText(size,smallFont);
                var label=new Rectangle(Math.Max(8,Math.Min(selection.Left,ClientSize.Width-labelSize.Width-24)),Math.Max(8,selection.Top-34),labelSize.Width+16,26);
                using(var brush=new SolidBrush(Color.FromArgb(238,20,28,42))) g.FillRectangle(brush,label);
                TextRenderer.DrawText(g,size,smallFont,label,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
                if(dragging==null && selection.Width>=RegionMath.Minimum && selection.Height>=RegionMath.Minimum)
                {
                    int toolbarX=Math.Max(8,Math.Min(selection.Right-298,ClientSize.Width-306));
                    int toolbarY=selection.Bottom+14;
                    if(toolbarY+44>ClientSize.Height-8) toolbarY=Math.Max(8,selection.Bottom-58);
                    var toolbar=new Rectangle(toolbarX,toolbarY,298,44);
                    using(var brush=new SolidBrush(Color.FromArgb(24,33,48))) g.FillRectangle(brush,toolbar);
                    cancelButton=new Rectangle(toolbarX+6,toolbarY+6,134,32);
                    confirmButton=new Rectangle(toolbarX+146,toolbarY+6,146,32);
                    using(var brush=new SolidBrush(accent)) g.FillRectangle(brush,confirmButton);
                    TextRenderer.DrawText(g,"取消  Esc",uiFont,cancelButton,Color.FromArgb(221,227,237),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
                    TextRenderer.DrawText(g,"确认区域  Enter",uiFont,confirmButton,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
                }
            }
            if(selection.IsEmpty)
            {
                var hint=new Rectangle(Math.Max(8,(ClientSize.Width-390)/2),32,390,46);
                using(var brush=new SolidBrush(Color.FromArgb(240,24,33,48))) g.FillRectangle(brush,hint);
                TextRenderer.DrawText(g,"拖动选择截图区域 · Esc 取消",uiFont,hint,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
            }
        }
        protected override void Dispose(bool disposing)
        {
            if(disposing) { snapshot.Dispose(); uiFont.Dispose(); smallFont.Dispose(); }
            base.Dispose(disposing);
        }
    }

    public sealed class AgentOptions
    {
        public string ServerUrl { get; set; }
        public string PairToken { get; set; }
        public Rectangle Region { get; set; }
        public string LogPath { get; set; }
    }
    public sealed class Batch { public string id { get; set; } public string mode { get; set; } }
    public sealed class RemoteRegion { public int x { get; set; } public int y { get; set; } public int width { get; set; } public int height { get; set; } }
    public sealed class Command
    {
        public string id { get; set; } public string type { get; set; } public Batch batch { get; set; }
        public RemoteRegion region { get; set; } public string text { get; set; } public string batchId { get; set; }
    }
    public sealed class PollResponse { public Command command { get; set; } }
    public sealed class Registration { public string clientId { get; set; } }
    public sealed class ApiException : Exception
    {
        public HttpStatusCode Status { get; private set; }
        public ApiException(HttpStatusCode status) : base("HTTP "+(int)status) { Status=status; }
    }
    public sealed class AgentApi : IDisposable
    {
        private readonly HttpClient http;
        private readonly JavaScriptSerializer json=new JavaScriptSerializer();
        public AgentApi(string serverUrl,string token) : this(serverUrl,token,new HttpClientHandler { UseProxy=false, AllowAutoRedirect=false }) { }
        public AgentApi(string serverUrl,string token,HttpMessageHandler handler)
        {
            Uri address;
            if(!Uri.TryCreate(serverUrl,UriKind.Absolute,out address) || (address.Scheme!="http" && address.Scheme!="https"))
                throw new ArgumentException("请输入 http://IP:端口 或 https://IP:端口");
            http=new HttpClient(handler); http.BaseAddress=new Uri(serverUrl.TrimEnd('/')+"/");
            http.Timeout=TimeSpan.FromSeconds(8);
            http.DefaultRequestHeaders.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",token);
        }
        private async Task<string> Send(HttpMethod method,string route,HttpContent body)
        {
            using(var request=new HttpRequestMessage(method,route))
            {
                request.Content=body;
                using(var response=await http.SendAsync(request))
                {
                    if(!response.IsSuccessStatusCode) throw new ApiException(response.StatusCode);
                    return await response.Content.ReadAsStringAsync();
                }
            }
        }
        public async Task<string> Post(string route,object payload)
        {
            return await Send(HttpMethod.Post,route,new StringContent(json.Serialize(payload),Encoding.UTF8,"application/json"));
        }
        public async Task Register()
        {
            var result=json.Deserialize<Registration>(await Post("api/source/register",new { name=Environment.MachineName }));
            if(result==null || String.IsNullOrWhiteSpace(result.clientId)) throw new InvalidDataException("控制端没有返回 clientId");
            http.DefaultRequestHeaders.Remove("X-Client-Id");
            http.DefaultRequestHeaders.Add("X-Client-Id",result.clientId);
        }
        public async Task<Command> Poll(string ack)
        {
            var result=json.Deserialize<PollResponse>(await Send(HttpMethod.Get,"api/source/poll?ack="+Uri.EscapeDataString(ack??""),null));
            return result==null?null:result.command;
        }
        public async Task Frame(string batchId,byte[] bytes)
        {
            string route="api/frame?batchId="+Uri.EscapeDataString(batchId)+"&frameId="+Guid.NewGuid().ToString()+"&capturedAt="+Uri.EscapeDataString(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture));
            for(int attempt=0;attempt<2;attempt++)
            {
                var body=new ByteArrayContent(bytes); body.Headers.ContentType=new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
                try { await Send(HttpMethod.Post,route,body); return; }
                catch(ApiException ex) { if(attempt!=0 || (int)ex.Status<500) throw; }
                catch(HttpRequestException) { if(attempt!=0) throw; }
                catch(TaskCanceledException) { if(attempt!=0) throw; }
            }
        }
        public void Dispose() { http.Dispose(); }
    }

    public sealed class TrayAgent : ApplicationContext
    {
        private readonly AgentOptions options;
        private readonly AgentApi api;
        private readonly CaptureState state=new CaptureState();
        private readonly NotifyIcon tray;
        private readonly Icon icon;
        private readonly ContextMenuStrip menu;
        private readonly ToolStripMenuItem statusItem,regionItem;
        private readonly System.Windows.Forms.Timer timer;
        private readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
        private readonly Form dispatcher=new Form();
        private RegionSelector selector;
        private Batch batch;
        private string pendingFinishId,pendingFinishError;
        private int count;
        private long nextShot;
        private string ack="",lastCommand="",lastStatus="";
        private bool registered,busy,closing,authBlocked;
        private Task activeTick=Task.FromResult(0);
        private DateTime retryAt=DateTime.MinValue;

        public TrayAgent(AgentOptions value)
        {
            options=value;
            if(RegionMath.IsValid(value.Region,SystemInformation.VirtualScreen)) state.Region=value.Region;
            api=new AgentApi(value.ServerUrl,value.PairToken);
            dispatcher.ShowInTaskbar=false;
            IntPtr handle=dispatcher.Handle;
            icon=CreateIcon();
            menu=new ContextMenuStrip { Font=new Font("Microsoft YaHei UI",9f) };
            statusItem=new ToolStripMenuItem("正在连接…") { Enabled=false };
            regionItem=new ToolStripMenuItem("尚未选择截图区域") { Enabled=false };
            menu.Items.Add(statusItem); menu.Items.Add(regionItem); menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("重新选择区域",null,delegate { QueueSelection(); });
            menu.Items.Add("重新连接",null,delegate { if(!busy) { authBlocked=false; retryAt=DateTime.MinValue; SetStatus("正在重新连接",true); } });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出采集器",null,async delegate { await Stop(); });
            tray=new NotifyIcon { Icon=icon, Text="拾页 · 正在连接", ContextMenuStrip=menu, Visible=true };
            tray.MouseClick+=delegate(object sender,MouseEventArgs e) { if(e.Button==MouseButtons.Left) QueueSelection(); };
            timer=new System.Windows.Forms.Timer { Interval=150 };
            timer.Tick+=async delegate {
                if(busy || closing) return;
                activeTick=Tick();
                await activeTick;
            };
            timer.Start(); UpdateRegion(); SetStatus("正在连接控制端",true);
        }
        private void Log(string message)
        {
            string line=DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")+" "+message;
            Console.WriteLine(line);
            try { if(!String.IsNullOrEmpty(options.LogPath)) File.AppendAllText(options.LogPath,line+Environment.NewLine,Encoding.UTF8); } catch(IOException) { } catch(UnauthorizedAccessException) { }
        }
        private void SetStatus(string message,bool log)
        {
            if(closing) return;
            statusItem.Text=message;
            tray.Text=("拾页 · "+message).Length>63?("拾页 · "+message).Substring(0,63):"拾页 · "+message;
            if(log && message!=lastStatus) Log(message);
            lastStatus=message;
        }
        private void UpdateRegion()
        {
            Rectangle r=state.Region;
            regionItem.Text=state.CanCapture?String.Format("区域 {0} × {1}  ·  ({2}, {3})",r.Width,r.Height,r.X,r.Y):"尚未选择截图区域";
        }
        private void QueueSelection()
        {
            if(closing || state.Selecting) return;
            state.BeginSelection(); SelectAfterMenu();
        }
        private async void SelectAfterMenu()
        {
            // Let Explorer dismiss its tray flyout before taking a local snapshot.
            await Task.Delay(250);
            if(closing) return;
            Rectangle? result=null;
            try
            {
                Rectangle bounds=SystemInformation.VirtualScreen;
                if((long)bounds.Width*bounds.Height>100000000) throw new InvalidOperationException("屏幕总尺寸过大");
                Bitmap picture=new Bitmap(bounds.Width,bounds.Height);
                using(selector=new RegionSelector(picture,bounds,state.Region,true))
                {
                    if(selector.ShowDialog()==DialogResult.OK) result=selector.SelectedRegion;
                }
            }
            catch(Exception ex) { Log("选区失败: "+ex.Message); if(!closing) SetStatus("选区失败，请重试",false); }
            finally
            {
                selector=null;
                state.EndSelection(result);
                nextShot=clock.ElapsedMilliseconds+1000;
                if(!closing) { UpdateRegion(); if(result.HasValue) Log("截图区域: "+result.Value.ToString()); }
            }
        }
        private async Task Finish(string error)
        {
            if(batch!=null) { pendingFinishId=batch.id; pendingFinishError=error; batch=null; }
            if(pendingFinishId==null) return;
            await api.Post("api/source/finish",new { batchId=pendingFinishId,error=pendingFinishError??"" });
            pendingFinishId=null; pendingFinishError=null;
        }
        private byte[] Screenshot()
        {
            Rectangle r=state.Region;
            if(!state.CanCapture || !RegionMath.IsValid(r,SystemInformation.VirtualScreen)) throw new InvalidOperationException("截图区域不再有效，请重新选择");
            using(var bitmap=new Bitmap(r.Width,r.Height))
            using(var graphics=Graphics.FromImage(bitmap))
            using(var stream=new MemoryStream())
            {
                graphics.CopyFromScreen(r.Location,Point.Empty,r.Size);
                bitmap.Save(stream,ImageFormat.Png); return stream.ToArray();
            }
        }
        private async Task Tick()
        {
            if(busy||closing||authBlocked||DateTime.UtcNow<retryAt) return;
            busy=true;
            try
            {
                if(!registered)
                {
                    await api.Register(); if(closing) return;
                    registered=true; Log("Connected. 已连接控制端，等待采集指令。");
                }
                if(pendingFinishId!=null) await Finish(pendingFinishError);
                if(closing) return;
                Command command=await api.Poll(ack); if(closing) return;
                if(command!=null && command.id!=lastCommand)
                {
                    if(command.type=="capture")
                    {
                        if(command.batch==null || String.IsNullOrEmpty(command.batch.id)) throw new InvalidDataException("无效的采集指令");
                        if(batch!=null) await Finish("被新的采集批次替代");
                        batch=command.batch; count=0; nextShot=clock.ElapsedMilliseconds+(batch.mode=="single"?0:1000);
                    }
                    else if(command.type=="stop") await Finish("");
                    else if(command.type=="exit") { RequestStop(); return; }
                    else if(command.type=="region" && command.region!=null)
                    {
                        RemoteRegion r=command.region; var rect=new Rectangle(r.x,r.y,r.width,r.height);
                        if(!RegionMath.IsValid(rect,SystemInformation.VirtualScreen)) Log("已拒绝无效的远程截图区域");
                        else if(state.Selecting) Log("本地正在选区，已忽略远程区域变更");
                        else { state.Region=rect; UpdateRegion(); }
                    }
                    else if(command.type=="question") await api.Post("api/source/question",new { text=command.text,batchId=command.batchId });
                    ack=lastCommand=command.id;
                }
                if(closing) return;
                if(batch!=null && !state.Selecting && !state.CanCapture) await Finish("请先点击采集端托盘图标选择截图区域");
                if(batch!=null && state.CanCapture && clock.ElapsedMilliseconds>=nextShot)
                {
                    byte[] bytes=Screenshot();
                    await api.Frame(batch.id,bytes); if(closing) return;
                    count++;
                    if(batch.mode=="single" || (batch.mode=="five" && count>=5)) await Finish("");
                    else nextShot=Math.Max(nextShot+1000,clock.ElapsedMilliseconds);
                }
                SetStatus(state.Selecting?"选区中 · 采集已暂停":!state.CanCapture?"已连接 · 点击图标选区":batch!=null?"正在采集":"已连接 · 等待指令",false);
            }
            catch(Exception ex)
            {
                if(closing) return;
                if(batch!=null) { pendingFinishId=batch.id; pendingFinishError="采集暂停: "+ex.Message; batch=null; }
                var apiError=ex as ApiException;
                if(apiError!=null && apiError.Status==HttpStatusCode.Unauthorized)
                {
                    authBlocked=true; registered=false;
                    SetStatus("配对失效 · 请用新配对码重启",true);
                }
                else
                {
                    retryAt=DateTime.UtcNow.AddSeconds(apiError!=null && apiError.Status==HttpStatusCode.Conflict?16:3);
                    SetStatus("连接异常 · 将自动重试",true);
                    Log("请求失败: "+ex.GetType().Name+" "+ex.Message);
                }
            }
            finally { busy=false; }
        }
        private async void RequestStop() { await Stop(); }
        private async Task Stop()
        {
            if(closing) return;
            closing=true; timer.Stop();
            if(selector!=null) { selector.DialogResult=DialogResult.Cancel; selector.Close(); }
            tray.Visible=false;
            // Let an upload or poll finish before finishing its batch or disposing HttpClient.
            try { await activeTick; } catch(Exception) { }
            try { await Finish("采集器已退出"); } catch(Exception) { }
            ExitThread();
        }
        protected override void ExitThreadCore()
        {
            closing=true; timer.Stop(); tray.Visible=false; base.ExitThreadCore();
        }
        protected override void Dispose(bool disposing)
        {
            if(disposing) { timer.Dispose(); tray.Dispose(); menu.Dispose(); icon.Dispose(); api.Dispose(); dispatcher.Dispose(); }
            base.Dispose(disposing);
        }
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
        private static Icon CreateIcon()
        {
            using(var bitmap=new Bitmap(32,32))
            using(var g=Graphics.FromImage(bitmap))
            {
                g.SmoothingMode=SmoothingMode.AntiAlias;
                using(var brush=new SolidBrush(Color.FromArgb(35,116,236))) g.FillEllipse(brush,1,1,30,30);
                using(var pen=new Pen(Color.White,2.4f))
                {
                    g.DrawLines(pen,new PointF[] { new PointF(8,13),new PointF(8,8),new PointF(13,8) });
                    g.DrawLines(pen,new PointF[] { new PointF(19,8),new PointF(24,8),new PointF(24,13) });
                    g.DrawLines(pen,new PointF[] { new PointF(24,19),new PointF(24,24),new PointF(19,24) });
                    g.DrawLines(pen,new PointF[] { new PointF(13,24),new PointF(8,24),new PointF(8,19) });
                }
                using(var brush=new SolidBrush(Color.White)) g.FillEllipse(brush,13,13,6,6);
                IntPtr handle=bitmap.GetHicon();
                try { using(var temporary=Icon.FromHandle(handle)) return (Icon)temporary.Clone(); }
                finally { DestroyIcon(handle); }
            }
        }
    }

    public static class AgentApp
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        public static void Initialize()
        {
            try { if(!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch(EntryPointNotFoundException) { SetProcessDPIAware(); }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        }
        public static bool Configure(AgentOptions options)
        {
            if(!String.IsNullOrWhiteSpace(options.ServerUrl)&&!String.IsNullOrWhiteSpace(options.PairToken)) return true;
            using(var form=new Form())
            {
                form.Text="拾页 · 连接控制端"; form.ClientSize=new Size(470,250); form.StartPosition=FormStartPosition.CenterScreen;
                form.FormBorderStyle=FormBorderStyle.FixedDialog; form.MaximizeBox=false; form.MinimizeBox=false;
                form.Font=new Font("Microsoft YaHei UI",10f);
                var server=new TextBox { Left=24,Top=53,Width=422,Text=options.ServerUrl??"" };
                var token=new TextBox { Left=24,Top=122,Width=422,UseSystemPasswordChar=true,Text=options.PairToken??"" };
                form.Controls.Add(new Label { Left=24,Top=24,Width=420,Text="控制端地址，例如 http://192.168.0.21:8787" });
                form.Controls.Add(server);
                form.Controls.Add(new Label { Left=24,Top=93,Width=420,Text="当前配对码（仅本次使用，不保存）" });
                form.Controls.Add(token);
                var connect=new Button { Left=324,Top=184,Width=122,Height=38,Text="连接" };
                connect.Click+=delegate {
                    Uri uri;
                    if(!Uri.TryCreate(server.Text.Trim(),UriKind.Absolute,out uri)||(uri.Scheme!="http"&&uri.Scheme!="https")||String.IsNullOrWhiteSpace(token.Text))
                    { MessageBox.Show(form,"请输入有效的控制端地址和配对码。","拾页"); return; }
                    options.ServerUrl=server.Text.Trim(); options.PairToken=token.Text.Trim(); form.DialogResult=DialogResult.OK;
                };
                form.Controls.Add(connect); form.AcceptButton=connect;
                return form.ShowDialog()==DialogResult.OK;
            }
        }
        public static void Run(AgentOptions options)
        {
            bool created;
            using(var mutex=new Mutex(true,"Local\\ShiyeScreenAgent",out created))
            {
                if(!created) { MessageBox.Show("采集器已在运行，请点击通知区域中的蓝色取景框图标。","拾页"); return; }
                try { if(Configure(options)) using(var context=new TrayAgent(options)) Application.Run(context); }
                finally { mutex.ReleaseMutex(); }
            }
        }
        public static Rectangle? SelectRegion(Rectangle previous)
        {
            Rectangle bounds=SystemInformation.VirtualScreen;
            var bitmap=new Bitmap(bounds.Width,bounds.Height);
            using(var selector=new RegionSelector(bitmap,bounds,previous,true))
                return selector.ShowDialog()==DialogResult.OK?(Rectangle?)selector.SelectedRegion:null;
        }
    }
}
