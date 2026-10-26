"""模拟行情引擎。

使用几何布朗运动 + 均值回归生成价格序列，并维护当日分时曲线。
引擎在后台线程中按固定间隔 tick，把最新快照广播给所有 SSE 订阅者。

设计目标：
- 零第三方依赖，只使用标准库；
- 线程安全，HTTP 处理线程可并发读取快照；
- 数据结构贴近真实行情的字段（最新价 / 开高低收 / 涨跌幅 / 成交量）。
"""

from __future__ import annotations

import math
import queue
import random
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Callable

# 启动时回溯填充的分时点数（1 点 = 1 分钟）
SEED_MINUTES = 240
# 内存中保留的最大分时点数
MAX_HISTORY = 720
# 列表页迷你走势图采样点数
SPARK_LEN = 40
# 价格回归均值的强度，避免长时间漂移偏离基准价太远
MEAN_REVERT = 0.05


@dataclass(frozen=True)
class Instrument:
    """标的的静态属性。"""

    symbol: str
    name: str
    market: str
    currency: str
    decimals: int
    prev_close: float
    # 单次 tick 的对数收益标准差
    tick_vol: float
    # 单次 tick 的平均成交量
    lot_volume: float


@dataclass
class _State:
    """标的的可变行情状态。"""

    inst: Instrument
    price: float = 0.0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    volume: float = 0.0
    # (毫秒时间戳, 价格)
    history: list[tuple[int, float]] = field(default_factory=list)


DEFAULT_INSTRUMENTS: tuple[Instrument, ...] = (
    # 指数
    Instrument("000001.SH", "上证指数", "指数", "CNY", 2, 3218.45, 0.00022, 2.4e8),
    Instrument("399001.SZ", "深证成指", "指数", "CNY", 2, 10342.18, 0.00026, 2.9e8),
    Instrument("399006.SZ", "创业板指", "指数", "CNY", 2, 2048.63, 0.00034, 1.6e8),
    Instrument("HSI.HK", "恒生指数", "指数", "HKD", 2, 17852.30, 0.00030, 1.2e8),
    # A 股
    Instrument("600519.SH", "贵州茅台", "A股", "CNY", 2, 1583.20, 0.00040, 2.6e4),
    Instrument("300750.SZ", "宁德时代", "A股", "CNY", 2, 181.45, 0.00055, 3.8e5),
    Instrument("601318.SH", "中国平安", "A股", "CNY", 2, 47.28, 0.00040, 6.2e5),
    Instrument("000858.SZ", "五粮液", "A股", "CNY", 2, 128.64, 0.00045, 3.1e5),
    # 美股
    Instrument("AAPL.US", "苹果", "美股", "USD", 2, 226.52, 0.00038, 8.4e5),
    Instrument("NVDA.US", "英伟达", "美股", "USD", 2, 122.86, 0.00062, 1.6e6),
    Instrument("TSLA.US", "特斯拉", "美股", "USD", 2, 218.42, 0.00075, 1.1e6),
    Instrument("MSFT.US", "微软", "美股", "USD", 2, 415.28, 0.00036, 6.5e5),
    # 港股
    Instrument("00700.HK", "腾讯控股", "港股", "HKD", 2, 372.40, 0.00048, 4.2e5),
    Instrument("09988.HK", "阿里巴巴", "港股", "HKD", 2, 78.95, 0.00055, 5.6e5),
    # 外汇
    Instrument("USD/CNY", "美元/人民币", "外汇", "CNY", 4, 7.1025, 0.00008, 0.0),
    Instrument("EUR/USD", "欧元/美元", "外汇", "USD", 4, 1.0855, 0.00009, 0.0),
    # 商品
    Instrument("XAU/USD", "现货黄金", "商品", "USD", 2, 2386.40, 0.00028, 3.6e4),
    Instrument("WTI.US", "WTI 原油", "商品", "USD", 2, 78.52, 0.00045, 4.8e4),
    # 加密货币
    Instrument("BTC/USDT", "比特币", "加密", "USDT", 2, 63480.00, 0.00085, 18.5),
    Instrument("ETH/USDT", "以太坊", "加密", "USDT", 2, 2486.50, 0.00095, 240.0),
    Instrument("SOL/USDT", "Solana", "加密", "USDT", 2, 148.62, 0.00120, 1800.0),
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class MarketEngine:
    """线程安全的模拟行情引擎。"""

    def __init__(
        self,
        instruments: tuple[Instrument, ...] | list[Instrument] | None = None,
        interval: float = 1.0,
        seed: int | None = None,
    ) -> None:
        self._rng = random.Random(seed)
        self._interval = max(0.1, float(interval))
        self._lock = threading.RLock()
        self._book: dict[str, _State] = {}
        self._order: list[str] = []
        self._subs: set[queue.Queue] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        for inst in instruments or DEFAULT_INSTRUMENTS:
            self._order.append(inst.symbol)
            self._book[inst.symbol] = self._seed_state(inst)

    # ------------------------------------------------------------------ 初始化

    def _seed_state(self, inst: Instrument) -> _State:
        """构造标的初始状态，并回溯填充当日分时。"""
        now = _now_ms()
        open_price = inst.prev_close * math.exp(self._rng.gauss(0, 0.003))
        price = open_price
        high = low = open_price

        history: list[tuple[int, float]] = []
        start = now - (SEED_MINUTES - 1) * 60_000
        # 把秒级波动放大到分钟级
        step_vol = inst.tick_vol * math.sqrt(45)
        for i in range(SEED_MINUTES - 1):
            price *= math.exp(self._rng.gauss(0, step_vol))
            high = max(high, price)
            low = min(low, price)
            history.append((start + i * 60_000, price))
        history.append((now, price))

        return _State(
            inst=inst,
            price=price,
            open=open_price,
            high=high,
            low=low,
            volume=inst.lot_volume * (20 + self._rng.random() * 30),
            history=history,
        )

    # -------------------------------------------------------------- 生命周期

    def start(self) -> None:
        """启动后台 tick 线程（幂等）。"""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="market-engine", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.tick()
            except Exception:  # 单次 tick 出错不应终止整个引擎
                traceback.print_exc()

    # ------------------------------------------------------------------ 行情

    def tick(self) -> list[dict]:
        """推进一次行情，并广播快照。"""
        now = _now_ms()
        with self._lock:
            for symbol in self._order:
                st = self._book[symbol]
                inst = st.inst
                revert = (inst.prev_close - st.price) / inst.prev_close * MEAN_REVERT
                st.price *= math.exp(self._rng.gauss(0, inst.tick_vol) + revert)
                st.high = max(st.high, st.price)
                st.low = min(st.low, st.price)
                st.volume += inst.lot_volume * (0.5 + self._rng.random() * 1.5)

                last_ts, _ = st.history[-1]
                if now - last_ts >= 60_000:
                    st.history.append((now, st.price))
                    if len(st.history) > MAX_HISTORY:
                        del st.history[: len(st.history) - MAX_HISTORY]
                else:
                    st.history[-1] = (last_ts, st.price)

            snapshot = [self._quote_locked(self._book[s], now) for s in self._order]

        self._broadcast(snapshot)
        return snapshot

    def snapshot(self) -> list[dict]:
        """返回全市场最新快照。"""
        now = _now_ms()
        with self._lock:
            return [self._quote_locked(self._book[s], now) for s in self._order]

    def history(self, symbol: str, limit: int = 0) -> tuple[dict | None, list[dict]]:
        """返回单个标的的报价与分时序列。"""
        with self._lock:
            st = self._book.get(symbol)
            if st is None:
                return None, []
            items = st.history[-limit:] if limit > 0 else st.history
            digits = st.inst.decimals + 2
            points = [{"t": ts, "p": round(price, digits)} for ts, price in items]
            return self._quote_locked(st, _now_ms()), points

    def _quote_locked(self, st: _State, now: int) -> dict:
        inst = st.inst
        change = st.price - inst.prev_close
        change_pct = change / inst.prev_close * 100 if inst.prev_close else 0.0
        digits = inst.decimals + 2
        return {
            "symbol": inst.symbol,
            "name": inst.name,
            "market": inst.market,
            "currency": inst.currency,
            "decimals": inst.decimals,
            "price": round(st.price, digits),
            "open": round(st.open, digits),
            "prevClose": round(inst.prev_close, digits),
            "high": round(st.high, digits),
            "low": round(st.low, digits),
            "change": round(change, digits),
            "changePct": round(change_pct, 2),
            "volume": round(st.volume),
            "time": now,
            "spark": [round(price, digits) for _, price in st.history[-SPARK_LEN:]],
        }

    # ------------------------------------------------------------------ 订阅

    def subscribe(self, maxsize: int = 8) -> tuple[queue.Queue, Callable[[], None]]:
        """订阅行情快照，返回 (队列, 取消订阅函数)。"""
        q: queue.Queue = queue.Queue(maxsize=maxsize)
        with self._lock:
            self._subs.add(q)

        def unsubscribe() -> None:
            with self._lock:
                self._subs.discard(q)

        return q, unsubscribe

    def _broadcast(self, snapshot: list[dict]) -> None:
        with self._lock:
            subscribers = list(self._subs)
        for q in subscribers:
            try:
                q.put_nowait(snapshot)
            except queue.Full:
                # 客户端处理不过来时丢弃最旧的一帧，保证推送不阻塞
                try:
                    q.get_nowait()
                    q.put_nowait(snapshot)
                except (queue.Empty, queue.Full):
                    pass
