# FinStream · 金融行情网页

一个使用 **Python 标准库** 实现的金融行情演示站点，零第三方依赖，开箱即跑。

## 功能

- 21 个标的：A 股 / 港股 / 美股 / 指数 / 外汇 / 商品 / 加密货币
- 顶部指数概览卡片（含迷你走势图）
- 顶部无缝滚动行情条
- 自选列表：市场筛选、代码/名称搜索、按最新价/涨跌幅/成交量排序
- 详情面板：Canvas 手绘分时图、昨收参考线、最新价气泡、开高低收/振幅/成交量
- SSE（Server-Sent Events）每秒推送一次全市场快照，断线自动重连
- 深色金融终端主题，自适应窄屏

## 运行

要求 Python 3.9+（无需 pip 安装任何包）。

```bash
cd "D:\知识\编程\项目\web"
python server.py
```

然后打开 <http://127.0.0.1:8000>。

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址，局域网访问用 `0.0.0.0` |
| `--port` | `8000` | 监听端口 |
| `--interval` | `1.0` | 行情刷新间隔（秒） |
| `--seed` | 随机 | 固定随机种子，便于复现数据 |

如果系统 PATH 中的 `python` 不可用（如 Windows 应用商店别名），请使用完整路径，例如：

```powershell
& "C:\Users\<你>\AppData\Local\Programs\Python\Python312\python.exe" server.py
```

## 目录结构

```
D:\知识\编程\项目\web\
├── server.py          # HTTP 服务、路由、SSE
├── market.py          # 模拟行情引擎（GBM + 均值回归）
├── web/
│   ├── index.html     # 页面结构
│   ├── style.css      # 深色终端主题
│   └── app.js         # SSE 接入、表格渲染、Canvas 分时图
├── start.bat          # Windows 一键启动
├── stop.bat           # 按端口停止服务
├── README.md          # 简要说明
├── 说明文档.md        # 完整说明（架构、接口、扩展、FAQ）
└── 问答与发布指南.md  # 运行原理、局域网共享、产品发布流程
```

完整文档见 [说明文档.md](./说明文档.md)。

## API

### GET /api/snapshot

全市场快照。

```json
{
  "quotes": [
    {
      "symbol": "000001.SH",
      "name": "上证指数",
      "market": "指数",
      "currency": "CNY",
      "decimals": 2,
      "price": 3218.45,
      "open": 3198.62,
      "prevClose": 3200.11,
      "high": 3225.4,
      "low": 3192.03,
      "change": 18.34,
      "changePct": 0.57,
      "volume": 239401123,
      "time": 1761000000000,
      "spark": [3198.62, 3204.11, 3218.45]
    }
  ],
  "serverTime": 1761000000000
}
```

### GET /api/history?symbol=000001.SH&limit=240

单个标的的分时序列（`limit` 可选，默认返回全部，最多 720 点）。

```json
{
  "quote": { "...": "同 snapshot 中的单条报价" },
  "points": [{ "t": 1760997600000, "p": 3198.62 }]
}
```

### GET /api/stream

SSE 长连接，事件名为 `quotes`，每秒推送一帧与 `/api/snapshot` 结构相同的数据；15 秒无数据时发送 `: ping` 心跳。

## 数据说明

行情由 `market.py` 本地生成，**不是真实市场数据**：

- 启动时为每个标的回溯生成 240 分钟分时；
- 每个 tick 使用 `exp(σ·Z + 均值回归项)` 更新价格，并累计成交量；
- 每日 60 秒追加一个分时点，内存最多保留 720 点。

接入真实行情时，只需替换 `MarketEngine.tick()` 的数据来源，例如拉取交易所/行情商的 REST 或 WebSocket 数据后写入 `self._book[symbol]`，前端无需改动。

## 免责声明

本项目仅用于技术演示，数据为模拟生成，不构成任何投资建议。
