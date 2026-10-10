using System;
using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Reflection;
using System.Windows.Forms;
using Shiye;

public sealed class ProtocolFixture : HttpMessageHandler
{
    public int Requests,Frames;
    public bool Unauthorized,FailFrame;
    public string FirstFrameUri;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
    {
        Requests++;
        if(request.Headers.Authorization==null || request.Headers.Authorization.ToString()!="Bearer fixture-token") throw new Exception("Authorization header missing");
        string path=request.RequestUri.AbsolutePath;
        string reply="{}";
        if(Unauthorized) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
        if(path=="/api/source/register")
        {
            if(request.Method!=HttpMethod.Post || !(await request.Content.ReadAsStringAsync()).Contains("\"name\"")) throw new Exception("Invalid registration");
            reply="{\"clientId\":\"fixture-client\"}";
        }
        else
        {
            if(!request.Headers.Contains("X-Client-Id") || String.Join("",request.Headers.GetValues("X-Client-Id"))!="fixture-client") throw new Exception("Client ID not propagated");
            if(path=="/api/source/poll")
            {
                if(request.RequestUri.Query!="?ack=a%26b") throw new Exception("Ack must be escaped");
                reply="{\"command\":{\"id\":\"cmd-1\",\"type\":\"capture\",\"batch\":{\"id\":\"batch-1\",\"mode\":\"five\"}}}";
            }
            else if(path=="/api/frame")
            {
                Frames++;
                if(request.Content.Headers.ContentType.MediaType!="image/png" || (await request.Content.ReadAsByteArrayAsync()).Length!=4) throw new Exception("Invalid frame body");
                if(FirstFrameUri==null) FirstFrameUri=request.RequestUri.ToString();
                else if(FirstFrameUri!=request.RequestUri.ToString()) throw new Exception("Retry must preserve frame ID");
                if(FailFrame && Frames==1) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            }
            else throw new Exception("Unexpected route: "+path);
        }
        return new HttpResponseMessage(HttpStatusCode.OK) { Content=new StringContent(reply) };
    }
}

public sealed class SelectorProbe : RegionSelector
{
    public SelectorProbe(Bitmap image,Rectangle previous) : base(image,new Rectangle(0,0,960,640),previous) { }
    public void Drag(int x,int y,int targetX,int targetY)
    {
        OnMouseDown(new MouseEventArgs(MouseButtons.Left,1,x,y,0));
        OnMouseMove(new MouseEventArgs(MouseButtons.Left,0,targetX,targetY,0));
        OnMouseUp(new MouseEventArgs(MouseButtons.Left,1,targetX,targetY,0));
    }
    public void Key(Keys key) { Message msg=new Message(); ProcessCmdKey(ref msg,key); }
    public void Render(string path)
    {
        using(var bitmap=new Bitmap(960,640))
        using(var graphics=Graphics.FromImage(bitmap))
        {
            OnPaint(new PaintEventArgs(graphics,new Rectangle(0,0,960,640)));
            bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}

public sealed class LifecycleFixture : HttpMessageHandler
{
    public int Polls,Frames,Finishes;
    public bool Unauthorized;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
    {
        string path=request.RequestUri.AbsolutePath;
        if(path=="/api/source/register") return Reply("{\"clientId\":\"test-client\"}");
        if(path=="/api/source/poll")
        {
            Polls++;
            await Task.Delay(20);
            if(Unauthorized) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            if(Polls==1) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            if(Polls==2) return Reply("{\"command\":{\"id\":\"capture-1\",\"type\":\"capture\",\"batch\":{\"id\":\"batch-1\",\"mode\":\"single\"}}}");
            return Reply("{\"command\":null}");
        }
        if(path=="/api/frame") { Frames++; return Reply("{}"); }
        if(path=="/api/source/finish") { Finishes++; return Reply("{}"); }
        throw new Exception("Unexpected route "+path);
    }
    private HttpResponseMessage Reply(string content) { return new HttpResponseMessage(HttpStatusCode.OK) { Content=new StringContent(content) }; }
}

public sealed class ShutdownFixture : HttpMessageHandler
{
    public readonly TaskCompletionSource<bool> ReleasePoll=new TaskCompletionSource<bool>();
    public bool PollStarted,FinishedTooSoon;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation)
    {
        if(request.RequestUri.AbsolutePath=="/api/source/register") return Reply("{\"clientId\":\"test-client\"}");
        if(request.RequestUri.AbsolutePath=="/api/source/poll") { PollStarted=true; await ReleasePoll.Task; return Reply("{\"command\":null}"); }
        if(request.RequestUri.AbsolutePath=="/api/source/finish") { FinishedTooSoon=!ReleasePoll.Task.IsCompleted; return Reply("{}"); }
        throw new Exception("Unexpected request during shutdown");
    }
    private HttpResponseMessage Reply(string content) { return new HttpResponseMessage(HttpStatusCode.OK) { Content=new StringContent(content) }; }
}

public static class AgentTests
{
    private static void Check(bool value,string message) { if(!value) throw new Exception(message); }
    public static async Task Protocol()
    {
        var fixture=new ProtocolFixture { FailFrame=true };
        using(var api=new AgentApi("http://fixture.local:8787","fixture-token",fixture))
        {
            await api.Register();
            Command command=await api.Poll("a&b");
            Check(command.id=="cmd-1" && command.batch.mode=="five","Command deserialization failed");
            await api.Frame("batch-1",new byte[] { 1,2,3,4 });
            Check(fixture.Frames==2,"Transient frame failure did not retry");
            fixture.Unauthorized=true;
            int before=fixture.Requests;
            try { await api.Poll("a&b"); throw new Exception("401 was swallowed"); }
            catch(ApiException ex) { Check(ex.Status==HttpStatusCode.Unauthorized,"Wrong auth failure"); }
            Check(fixture.Requests==before+1,"Authentication error retried unexpectedly");
        }
    }
    private static Bitmap Background()
    {
        var bitmap=new Bitmap(960,640);
        using(var g=Graphics.FromImage(bitmap))
        {
            g.Clear(Color.FromArgb(237,241,247));
            using(var brush=new SolidBrush(Color.White)) g.FillRectangle(brush,90,70,770,500);
            using(var brush=new SolidBrush(Color.FromArgb(42,60,86)))
            using(var font=new Font("Microsoft YaHei UI",21)) g.DrawString("示例页面 · 区域预览",font,brush,130,105);
            using(var pen=new Pen(Color.FromArgb(190,202,220),8))
                for(int y=180;y<500;y+=55) g.DrawLine(pen,130,y,760,y);
        }
        return bitmap;
    }
    public static void Selector(string output)
    {
        using(var selector=new SelectorProbe(Background(),Rectangle.Empty))
        {
            selector.Drag(700,480,180,140);
            Check(selector.SelectedRegion==new Rectangle(180,140,520,340),"Reverse drag failed");
            Check(selector.DialogResult==DialogResult.None,"Mouse-up must allow adjustment before confirming");
            selector.Drag(400,300,420,310);
            Check(selector.SelectedRegion==new Rectangle(200,150,520,340),"Interior dragging failed");
            selector.Drag(720,490,780,530);
            Check(selector.SelectedRegion==new Rectangle(200,150,580,380),"Resize handle failed");
            selector.Key(Keys.Left|Keys.Shift);
            Check(selector.SelectedRegion.X==190,"Keyboard adjustment failed");
            selector.Render(output);
            selector.Key(Keys.Enter);
            Check(selector.DialogResult==DialogResult.OK,"Enter must confirm");
        }
        using(var selector=new SelectorProbe(Background(),new Rectangle(100,100,400,300)))
        {
            selector.Key(Keys.Escape);
            Check(selector.DialogResult==DialogResult.Cancel,"Escape must cancel");
        }
    }
    private static FieldInfo Field(string name) { return typeof(TrayAgent).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance); }
    private static void Tick(TrayAgent agent)
    {
        var task=(Task)typeof(TrayAgent).GetMethod("Tick",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(agent,null);
        DateTime deadline=DateTime.UtcNow.AddSeconds(3);
        while(!task.IsCompleted && DateTime.UtcNow<deadline) { Application.DoEvents(); Thread.Sleep(1); }
        Check(task.IsCompleted,"Network operation stalled UI test"); task.GetAwaiter().GetResult();
    }
    public static void Lifecycle()
    {
        var options=new AgentOptions { ServerUrl="http://fixture.local",PairToken="fixture-token" };
        using(var agent=new TrayAgent(options))
        {
            ((System.Windows.Forms.Timer)Field("timer").GetValue(agent)).Stop();
            ((AgentApi)Field("api").GetValue(agent)).Dispose();
            var fixture=new LifecycleFixture();
            Field("api").SetValue(agent,new AgentApi(options.ServerUrl,options.PairToken,fixture));
            var state=(CaptureState)Field("state").GetValue(agent);
            var tray=(NotifyIcon)Field("tray").GetValue(agent);
            Tick(agent);
            Check(tray.Visible && !(bool)Field("closing").GetValue(agent),"Network failure must leave tray running");
            state.BeginSelection();
            Field("retryAt").SetValue(agent,DateTime.MinValue);
            Tick(agent);
            Check(fixture.Polls==2 && fixture.Frames==0 && Field("batch").GetValue(agent)!=null,"Selection must keep heartbeat while suppressing capture");
            state.EndSelection(null);
            Tick(agent);
            Check(fixture.Frames==0 && fixture.Finishes==1,"No region must reject capture without screenshot");
            fixture.Unauthorized=true;
            Tick(agent);
            int polls=fixture.Polls;
            Tick(agent);
            Check(tray.Visible && (bool)Field("authBlocked").GetValue(agent) && polls==fixture.Polls,"Auth failure must keep tray without repeated requests");
        }
    }
    public static void Shutdown()
    {
        using(var agent=new TrayAgent(new AgentOptions { ServerUrl="http://fixture.local",PairToken="fixture-token" }))
        {
            var timer=(System.Windows.Forms.Timer)Field("timer").GetValue(agent); timer.Stop();
            ((AgentApi)Field("api").GetValue(agent)).Dispose();
            var fixture=new ShutdownFixture();
            Field("api").SetValue(agent,new AgentApi("http://fixture.local","fixture-token",fixture));
            Field("batch").SetValue(agent,new Batch { id="pending-batch",mode="five" });
            typeof(System.Windows.Forms.Timer).GetMethod("OnTick",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(timer,new object[] { EventArgs.Empty });
            DateTime startDeadline=DateTime.UtcNow.AddSeconds(3);
            while(!fixture.PollStarted && DateTime.UtcNow<startDeadline) { Application.DoEvents(); Thread.Sleep(1); }
            Check(fixture.PollStarted,"Slow request did not start");
            Task stop=(Task)typeof(TrayAgent).GetMethod("Stop",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(agent,null);
            bool waited=!fixture.FinishedTooSoon && !stop.IsCompleted;
            fixture.ReleasePoll.SetResult(true);
            DateTime deadline=DateTime.UtcNow.AddSeconds(3);
            while(!stop.IsCompleted && DateTime.UtcNow<deadline) { Application.DoEvents(); Thread.Sleep(1); }
            Check(waited,"Shutdown finished batch before the in-flight request settled");
            Check(stop.IsCompleted,"Shutdown failed to complete after request settled");
        }
    }
}
