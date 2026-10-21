# 安卓通过 Wi-Fi 使用语音问答

解析端同时运行两个入口，共用配对码、截图端连接、模型选择、任务背景与记录。

| 设备与用途 | 地址 | 是否需要调整 |
|---|---|---|
| 本机解析端 | http://localhost:8790/ | 不需要 |
| 原截图端 | http://192.168.0.21:8790/ | 不需要 |
| 原手机截图控制页 | http://192.168.0.21:8790/ | 不需要 |
| 原拍照端 | http://192.168.0.21:8790/camera | 不强制调整；若浏览器不允许相机权限，改用下面的 HTTPS 地址 |
| 手机语音问答 | https://192.168.0.21:8791/voice | 安装 CA 证书后使用 |
| 手机 HTTPS 首页 | https://192.168.0.21:8791/ | 与原首页功能相同 |
| 手机 HTTPS 拍照端 | https://192.168.0.21:8791/camera | 可选，同样需要信任 CA |

## 手机首次配置

1. 手机与解析电脑连接同一个 Wi-Fi。
2. 用手机浏览器打开 http://192.168.0.21:8790/phone-ca.crt，下载 `shiyue-phone-ca.crt`。
3. 在安卓系统“设置”中搜索“安装证书”或“加密与凭据”。常见位置是“安全和隐私 → 更多安全设置 → 加密与凭据 → 安装证书 → CA 证书”。选择下载的文件，按系统提示确认并输入锁屏密码。不同品牌名称可能略有区别；这里需要安装 **CA 证书**。
4. 关闭并重新打开浏览器，访问 https://192.168.0.21:8791/，输入原来电脑终端显示的配对码。HTTP 与 HTTPS 是不同站点，首次需要重新配对，但配对码相同。
5. 点“语音问答”，左键开始或点“开始录音”，允许麦克风权限；右键结束或点“结束并回答”。

手机安装的只有本项目 CA 的公钥证书。电脑上的 `certs/phone-ca/rootCA-key.pem` 和 `certs/phone-server-key.pem` 是私钥，不应复制到手机。此 CA 未自动安装到电脑的信任库，本电脑继续使用原来的 HTTP localhost 入口。

本次 CA 的 SHA-256 指纹：

```text
2E:B4:21:CD:90:B7:1E:C0:86:67:BB:5D:5B:11:06:EA:72:7A:5D:36:55:DB:0B:16:26:27:93:70:08:05:55:11
```

## 解析端配置

本机 `.env` 已添加下面的配置，原有 `HOST`、`MOUSE_PORT`、配对码和 API 密钥继续使用。

```dotenv
MOUSE_HTTPS_PORT=8791
MOUSE_TLS_KEY=certs/phone-server-key.pem
MOUSE_TLS_CERT=certs/phone-server.pem
MOUSE_PHONE_CA=certs/phone-ca.crt
```

`TLS_KEY` / `TLS_CERT` 保持原值（本机为空）。这两项控制原有主入口，不要用它们替换本次附加 HTTPS 配置，否则原 HTTP 采集端地址将受影响。启动命令仍为 `npm run start:mouse`。

附加入口直接处理同一服务的请求和 WSS 连接，无需另外启动一个使用相同数据目录的服务。CA 下载路径只输出解析后的公钥证书，不开放 `certs/` 目录。所有证书和私钥都位于 Git 忽略的 `certs/` 下。

## 地址变化与排查

- 页面打不开：确认手机和电脑同网，电脑仍是 `192.168.0.21`，服务正在监听 8791，防火墙允许 Node.js 接收局域网连接。
- 浏览器报告证书不可信：检查是否安装了本次的 CA 证书，而非服务器证书或其他旧证书；重启浏览器后再试。仅点击“继续访问”不等同于建立可靠的麦克风权限环境。
- 网页正常但无法录音：确认地址以 `https://` 开头，在浏览器站点权限和安卓应用权限中允许麦克风，并保持页面前台。
- 电脑 IP 变化：建议在路由器为电脑保留 DHCP 地址。证书目前包含 `192.168.0.21`、`localhost`、`127.0.0.1`、`::1`，有效期至 2029-01-21。若 IP 变了，使用同一 CA 重新签发服务证书，再重启解析端；同一 CA 未变时手机不必重装证书。

重新签发示例（在项目目录，把 IP 换成新的地址）：

```powershell
$env:CAROOT = Join-Path (Get-Location) 'certs\phone-ca'
& '.\certs\tools\mkcert.exe' -cert-file 'certs\phone-server.pem' -key-file 'certs\phone-server-key.pem' '192.168.0.21' 'localhost' '127.0.0.1' '::1'
```

参考：[mkcert 的移动设备证书说明](https://github.com/FiloSottile/mkcert#mobile-devices)、[Android 证书设置说明](https://support.google.com/pixelphone/answer/2844832?hl=zh-Hans)。
