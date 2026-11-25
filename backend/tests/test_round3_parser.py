"""Round 3: real-world phrasings that the parser used to misread (audit of 25 Nov 2026)."""
import pytest

from app.strategy.explain import explain
from app.strategy.parser import RuleBasedParser

P = RuleBasedParser()


def conds(side):
    return [(c.left, c.op, c.right) for c in side]


def test_rsi_level_and_vwap_filter_are_both_kept():
    s = P.parse("Buy BankNifty CE when RSI above 60 and price above VWAP after 10 am, SL 20 points target 40 points").strategy
    assert s.direction == "long"
    assert ("rsi14", "crosses_above", 60.0) in conds(s.entry.long)
    assert ("close", "gt", "vwap") in conds(s.entry.long)
    assert s.exit.stop_loss_points == 20 and s.exit.target_points == 40


def test_ema_cross_keeps_rsi_filter():
    s = P.parse("Buy nifty call when 5 ema crosses 13 ema and rsi > 55 on 3 minute chart, trailing sl 10%").strategy
    assert ("ema5", "crosses_above", "ema13") in conds(s.entry.long)
    assert ("rsi14", "gt", 55.0) in conds(s.entry.long)
    assert s.exit.trailing_sl_pct == 10 and s.exit.stop_loss_pct is None


def test_adx_filter():
    s = P.parse("Buy Nifty futures when 9 EMA crosses above 21 EMA on 15 min and ADX above 25").strategy
    assert ("adx14", "gt", 25.0) in conds(s.entry.long)


def test_buy_then_sell_at_time_is_long():
    s = P.parse("Buy Infosys at 9:30 every day and sell at 3 pm").strategy
    assert s.direction == "long" and s.entry.long and not s.entry.short
    assert s.hard_exit == "15:00"
    assert "Buy INFY" in explain(s)


def test_short_sell_still_short():
    s = P.parse("Short SBI at 9:20 on 5 min, exit at 3 pm").strategy
    assert s.direction == "short"


def test_hinglish_baje_exit():
    s = P.parse("agar nifty 20 ema ke upar close kare to call buy karo, 3 baje exit").strategy
    assert s.hard_exit == "15:00"


def test_rsi_mean_reversion_unchanged():
    s = P.parse("Buy Reliance when RSI 14 drops below 30 on daily candles and sell when RSI crosses above 70. Stop loss 8%.").strategy
    assert ("rsi14", "crosses_below", 30.0) in conds(s.entry.long)
    assert ("rsi14", "crosses_above", 70.0) in conds(s.exit.long)


def test_buy_put_on_rsi_below_is_short_bias():
    s = P.parse("Buy Nifty put when RSI drops below 40 on 5 min").strategy
    assert s.direction == "short"
    assert ("rsi14", "crosses_below", 40.0) in conds(s.entry.short)


def test_positional_explain_has_no_intraday_limits():
    text = explain(P.parse("Buy TCS when 50 SMA crosses above 200 SMA on daily, exit when it crosses below").strategy)
    assert "New entries only" not in text and "a day" not in text and "opposite signal" in text


def test_exit_when_crosses_below_needs_no_warning():
    res = P.parse("Buy TCS when 50 SMA crosses above 200 SMA on daily, exit when it crosses below")
    assert not any("No exit signal" in w for w in res.warnings)


@pytest.mark.parametrize("text,word", [
    ("Nifty 9:20 iron condor with 100 point wings", "iron condor"),
    ("Buy Nifty when stochastic crosses above 20 on 5 min", "Stochastic"),
])
def test_unsupported_features_say_so(text, word):
    with pytest.raises(ValueError, match=word):
        P.parse(text)


def test_unsupported_extra_is_warned_not_silently_dropped():
    res = P.parse("Buy Nifty call when 9 EMA crosses above 21 EMA and stochastic is above 50 on 15 min")
    assert any("Stochastic" in w for w in res.warnings) and res.confidence < 0.9


def test_macd_signal_cross():
    s = P.parse("Buy Nifty futures when MACD crosses above signal line on 15 min").strategy
    assert ("macd", "crosses_above", "macd.signal") in conds(s.entry.long)


def test_macd_filter():
    s = P.parse("Buy Nifty call when 9 EMA crosses above 21 EMA and MACD is positive on 15 min").strategy
    assert ("macd", "gt", 0.0) in conds(s.entry.long)


def test_bollinger_upper_short_mirrors_to_lower():
    s = P.parse("Short Nifty futures when price closes above the upper Bollinger band on 5 min, target 0.5%").strategy
    assert s.direction == "short"
    assert ("close", "crosses_above", "bb.upper") in conds(s.entry.short)
    assert s.entry.short[0].mirrored().right == "bb.lower"


def test_previous_day_low_breakdown():
    s = P.parse("Buy Nifty put when price breaks below previous day low").strategy
    assert s.direction == "short" and ("close", "crosses_below", "pd.low") in conds(s.entry.short)


@pytest.mark.parametrize("text", [
    "Buy Nifty futures when MACD crosses above signal line on 15 min",
    "Short Nifty futures when price closes above the upper Bollinger band on 5 min, target 0.5%",
    "Buy BankNifty futures when price breaks above previous day high after 9:30, SL 0.5%",
])
def test_new_indicators_backtest_end_to_end(text):
    from app.backtest.engine import run_backtest
    from app.data.candles import resample
    from app.data.synthetic import generate_candles

    s = P.parse(text).strategy
    res = run_backtest(s, resample(generate_candles(s.underlying, days=60, seed=7, bar_minutes=5), s.timeframe), "synthetic")
    assert res is not None


def test_backtest_refuses_synthetic_when_disabled(monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.main import app

    monkeypatch.setattr(get_settings(), "allow_synthetic_data", False)
    r = TestClient(app).post("/api/backtests/run", json={"text": "Buy Nifty call when 9 EMA crosses above 21 EMA on 15 min"})
    assert r.status_code == 503 and "market data" in r.json()["detail"]
