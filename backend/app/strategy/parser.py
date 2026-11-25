"""Plain English -> Strategy DSL.

Two paths:
1. Deterministic rule-based parser (always available, no network, fully testable).
2. Optional LLM path (Gemini free tier or any OpenAI-compatible endpoint, see llm.py). The LLM must
   return JSON that validates against the Strategy schema; on any failure we fall back to rules.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from pydantic import ValidationError

from .dsl import Condition, EntryRules, ExitRules, IndicatorSpec, OptionSpec, RiskSpec, Strategy, TimeWindow


@dataclass
class ParseResult:
    strategy: Strategy
    method: str = "rules"  # rules | llm
    warnings: list[str] = field(default_factory=list)
    confidence: float = 0.8

    def to_dict(self) -> dict:
        return {"strategy": self.strategy.model_dump(), "method": self.method, "warnings": self.warnings, "confidence": self.confidence}


# --- vocabulary --------------------------------------------------------------------------------
INDEX_PATTERNS = [
    (r"\bbank\s?nifty\b|\bnifty\s?bank\b", "BANKNIFTY"),
    (r"\bfin\s?nifty\b|\bnifty\s?fin(ancial)?(\s?services)?\b", "FINNIFTY"),
    (r"\bmidcp\s?nifty\b|\bmidcap\s?nifty\b|\bnifty\s?midcap(\s?select)?\b", "MIDCPNIFTY"),
    (r"\bsensex\b", "SENSEX"),
    (r"\bnifty(\s?50)?\b", "NIFTY"),
]
EQUITY_ALIASES = {
    "reliance": "RELIANCE", "hdfc bank": "HDFCBANK", "hdfcbank": "HDFCBANK", "icici bank": "ICICIBANK", "icicibank": "ICICIBANK",
    "infosys": "INFY", "infy": "INFY", "tcs": "TCS", "sbi": "SBIN", "state bank": "SBIN", "axis bank": "AXISBANK",
    "kotak bank": "KOTAKBANK", "kotak mahindra bank": "KOTAKBANK", "itc": "ITC", "larsen": "LT", "l&t": "LT", "bajaj finance": "BAJFINANCE",
    "tata motors": "TATAMOTORS", "tata steel": "TATASTEEL", "maruti": "MARUTI", "wipro": "WIPRO", "hcl tech": "HCLTECH",
    "bharti airtel": "BHARTIARTL", "airtel": "BHARTIARTL", "adani enterprises": "ADANIENT", "sun pharma": "SUNPHARMA",
}
# Light Hinglish normalisation (roadmap: full regional-language support via the LLM path)
HINGLISH = {
    r"\b(\d{1,2})(?:[:.](\d{2}))?\s*baje\b": lambda m: f"{m.group(1)}:{m.group(2) or '00'}",
    r"\bkharido\b|\bkharid(o|na|en)?\b|\blo\b": "buy", r"\bbecho\b|\bbech(o|na|en)?\b": "sell", r"\bjab\b": "when",
    r"\bupar\b|\bupper\b": "above", r"\bneeche\b|\bniche\b": "below", r"\bke baad\b|\bbaad\b": "after",
    r"\bpe exit\b|\bpar exit\b": "exit at", r"\bka\b|\bki\b|\bke\b|\bko\b|\bse\b|\bkare?\b|\bkaro\b": " ",
}
TF_WORDS = [
    (r"\b(\d{1,2})\s*-?\s*(?:min(?:ute)?s?|mins?|m)\b(?:\s*(?:candle|chart|tf|timeframe|bar)s?)?", None),
    (r"\b(?:1|one)\s*-?\s*(?:hour|hr|h)\b|\bhourly\b", "1h"),
    # "daily candles" / "on daily" -- but not "daily loss limit" / "daily target"
    (r"\bdaily\s*(?:candles?|charts?|bars?|timeframe|tf)\b|\bon\s+(?:the\s+)?daily\b(?!\s*(?:loss|max|limit|cap|target|profit))|\b1\s*d(ay)?\s*candles?\b|\bday candles?\b", "1d"),
]
VALID_TF = {"1": "1m", "3": "3m", "5": "5m", "10": "10m", "15": "15m", "30": "30m", "60": "1h"}
TIME_RE = re.compile(r"(?<![\d.])(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d%])", re.I)


def _norm_time(h: int, m: int, ap: Optional[str]) -> Optional[str]:
    ap = (ap or "").replace(".", "").lower()
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    if not ap and 1 <= h <= 3:  # market hours: "3:15" means 15:15
        h += 12
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return f"{h:02d}:{m:02d}"


def _find_times(t: str) -> list[tuple[str, int, int]]:
    """(HH:MM, start, end) for explicit clock times inside market hours."""
    out = []
    for mt in TIME_RE.finditer(t):
        h, m, ap = int(mt.group(1)), mt.group(2), mt.group(3)
        if m is None and not ap:
            # bare number: only a time if preceded by at/after/by/till/before
            pre = t[max(0, mt.start() - 8): mt.start()]
            if not re.search(r"(at|after|by|till|until|before|from|to)\s*$", pre):
                continue
        val = _norm_time(h, int(m or 0), ap)
        if val and "09:00" <= val <= "15:30":
            out.append((val, mt.start(), mt.end()))
    return out


def _num(s: str) -> float:
    return float(s.replace(",", ""))


class RuleBasedParser:
    def parse(self, text: str) -> ParseResult:
        warnings: list[str] = []
        raw = (text or "").strip()
        if len(raw) > 4000:
            raise ValueError("Strategy text is too long (max 4000 characters).")
        t = " " + raw.lower().replace("₹", " rs ").replace("–", "-").replace("—", "-") + " "
        for pat, repl in HINGLISH.items():
            t = re.sub(pat, repl, t)
        t = re.sub(r"\s+", " ", t)

        # ---- underlying / instrument ----
        underlying = None
        for pat, sym in INDEX_PATTERNS:
            if re.search(pat, t):
                underlying = sym
                break
        is_index = underlying is not None
        if not underlying:
            for alias, sym in sorted(EQUITY_ALIASES.items(), key=lambda kv: -len(kv[0])):
                if re.search(r"\b" + re.escape(alias) + r"\b", t):
                    underlying = sym
                    break
        if not underlying:
            m = re.search(r"\b(?:buy|sell|short|trade)\s+([A-Z][A-Za-z&]{1,15}(?:\s[A-Z][a-z]+)?)", raw)
            if m and m.group(1).lower() not in ("when", "the", "atm", "itm", "otm", "call", "put"):
                underlying = re.sub(r"\W", "", m.group(1)).upper()
                warnings.append(f"Assumed {underlying} is an NSE equity symbol; please verify.")
            else:
                underlying = "NIFTY"
                is_index = True
                warnings.append("No instrument found; defaulted to NIFTY.")

        option_words = re.search(r"\b(call|put|ce|pe|options?|straddle|strangle|atm|itm|otm|premium|strike)\b", t)
        future_words = re.search(r"\b(futures?|fut)\b", t)
        if option_words:
            instrument_type = "option"
        elif future_words:
            instrument_type = "future"
        elif is_index:
            instrument_type = "option"
            warnings.append("Index without contract type; assumed ATM options (buy).")
        else:
            instrument_type = "equity"

        # ---- timeframe ----
        timeframe = None
        for pat, fixed in TF_WORDS:
            # "first 15 min" describes an opening range, not the candle timeframe
            m = next((x for x in re.finditer(pat, t) if not re.search(r"(first|opening|initial)\s*$", t[max(0, x.start() - 12): x.start()])), None)
            if m:
                if fixed:
                    timeframe = fixed
                else:
                    n = m.group(1)
                    if n in VALID_TF:
                        timeframe = VALID_TF[n]
                    else:
                        warnings.append(f"{n}-minute timeframe not supported; using 5m.")
                if timeframe:
                    break
        if not timeframe:
            timeframe = "5m"
            warnings.append("No timeframe given; using 5-minute candles.")

        # ---- verbs / option mode ----
        sell_mode = bool(re.search(r"\b(sell|short|write)\b[^.]{0,25}\b(atm|itm|otm|call|put|ce|pe|option|straddle|strangle)", t)) or bool(
            re.search(r"\b(atm|itm|otm)\s+(sell|selling|short)\b|\boption sell(ing|er)?\b|\bsell the opposite\b|\bopposite option\b", t)
        )
        moneyness = "itm" if re.search(r"\bitm\b|in[- ]the[- ]money", t) else "otm" if re.search(r"\botm\b|out[- ]of[- ]the[- ]money", t) else "atm"
        steps = 1
        ms = re.search(r"(\d+)\s*(?:strikes?|steps?)\s*(?:itm|otm|away|in the money|out of the money)", t)
        if ms:
            steps = int(ms.group(1))

        option = None
        direction = None
        if instrument_type == "option":
            if "straddle" in t:
                mode = "straddle_sell" if re.search(r"\b(sell|short|write)\b", t) else "straddle_buy"
            elif "strangle" in t:
                mode = "strangle_sell" if re.search(r"\b(sell|short|write)\b", t) else "strangle_buy"
            else:
                mode = f"{moneyness}_{'sell' if sell_mode else 'buy'}"
            expiry = "monthly" if re.search(r"\bmonthly\b", t) or underlying in ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY") else "weekly"
            option = OptionSpec(mode=mode, strike_steps=steps, expiry=expiry)
            has_call = re.search(r"\b(call|ce)\b", t)
            has_put = re.search(r"\b(put|pe)\b", t)
            if mode.startswith(("straddle", "strangle")):
                direction = "neutral"
            elif has_call and not has_put:
                direction = "short" if sell_mode else "long"
            elif has_put and not has_call:
                direction = "long" if sell_mode else "short"

        # The first trade verb sets the side ("buy at 9:30 and sell at 3 pm" is a long trade).
        first_verb = re.search(r"\b(buy|long|sell|short|write)\b", t)
        verb_short = bool(first_verb and first_verb.group(1) in ("sell", "short", "write"))

        # ---- indicators & entry conditions ----
        indicators: list[IndicatorSpec] = []
        long_c: list[Condition] = []
        short_c: list[Condition] = []
        exit_long: list[Condition] = []
        exit_short: list[Condition] = []

        def add_ind(spec: IndicatorSpec) -> str:
            for i in indicators:
                if i.id == spec.id:
                    return i.id
            indicators.append(spec)
            return spec.id

        # split entry clause vs exit clause
        exit_words = r"\b(?:exit|square\s?off|close (?:the )?(?:position|trade)|book profit)\b"
        if not verb_short:  # for a long trade, a later "sell when/at/if" is the exit
            exit_words += r"|\b(?:sell|squareoff)\s+(?:when|at|if|on|by)\b"
        exit_split = re.split(exit_words, t, maxsplit=1)
        entry_part = exit_split[0]
        exit_part = exit_split[1] if len(exit_split) > 1 else ""

        cross_up = re.search(r"cross(?:es|ing|ed)?\s+(?:over\s+)?(?:above|up|upward)\b|cross(?:es|ed)\s+over\b|bullish cross|golden cross|\babove\b[^.]{0,20}\bcross", entry_part)
        cross_dn = re.search(r"cross(?:es|ing|ed)?\s+(?:under\s+)?(?:below|down|downward|under)\b|bearish cross|death cross|\bbelow\b[^.]{0,20}\bcross", entry_part)
        both_ways = re.search(r"\bboth (?:ways|directions|sides)\b|\beither (?:way|direction)\b|\blong (?:and|&|or) short\b", t)
        if both_ways and direction is None:
            direction = "both"

        ma_pairs = re.findall(r"(\d{1,3})\s*/\s*(\d{1,3})\s*(ema|sma|dma)", t)
        mas = re.findall(r"(?:(\d{1,3})\s*-?\s*(?:period\s*|day\s*)?(ema|sma|dma)\b|\b(ema|sma|dma)\s*\(?\s*(\d{1,3}))", entry_part or t)
        ma_list: list[tuple[str, int]] = []
        for a, b, kind in ma_pairs:
            ma_list += [(kind, int(a)), (kind, int(b))]
        for p1, k1, k2, p2 in mas:
            kind, period = (k1, p1) if k1 else (k2, p2)
            if period and (kind, int(period)) not in ma_list:
                ma_list.append((kind, int(period)))
        ma_list = [("sma" if k == "dma" else k, p) for k, p in ma_list]

        orb = re.search(r"opening range|\borb\b|first (\d+) min", t)
        macd_m = re.search(r"\bmacd\b", t)
        bb_m = re.search(r"bollinger|\bbb\b", t)
        pd_m = re.search(r"(?:previous|prev|yesterday'?s?|last)\s*(?:day'?s?|session'?s?)?\s*(high|low|close)|\bpd([hl])\b", entry_part)

        def bias() -> str:
            return direction or ("short" if verb_short and instrument_type != "option" else "long")

        def attach(stated: Condition) -> str:
            """Put the user's stated condition on the side the trade implies; mirror it on the other."""
            b = bias()
            (short_c if b == "short" else long_c).append(stated)
            (long_c if b == "short" else short_c).append(stated.mirrored())
            return b
        rsi_m = re.search(r"\brsi\s*\(?\s*(\d{1,2})?\)?", t)
        st_m = re.search(r"super\s?trend\s*\(?\s*(\d{1,2})?\s*[,/ ]\s*(\d+(?:\.\d+)?)?", t)
        vwap_m = re.search(r"\bvwap\b", t)

        primary = None
        if orb:
            primary = "orb"
            times = _find_times(t)
            start, end = "09:15", "09:30"
            if orb.group(1):
                end_min = 15 + int(orb.group(1))
                end = f"{9 + end_min // 60:02d}:{end_min % 60:02d}"
            rng_times = [x[0] for x in times if x[0] <= "10:30"]
            if len(rng_times) >= 2:
                start, end = rng_times[0], rng_times[1]
            oid = add_ind(IndicatorSpec(id="orb", kind="orb", start=start, end=end))
            bear = re.search(r"break(?:s|ing)?\s*(?:down|below)|breakdown|below the|low of the", entry_part)
            bull = re.search(r"break(?:s|ing)?\s*(?:out|above)|breakout|above the|high of the", entry_part)
            long_c.append(Condition(left="close", op="crosses_above", right=f"{oid}.high"))
            short_c.append(Condition(left="close", op="crosses_below", right=f"{oid}.low"))
            if direction is None:
                direction = "short" if bear and not bull else "long" if bull and not bear else "both"
        elif len(ma_list) >= 2:
            primary = "ma"
            (k1, p1), (k2, p2) = ma_list[0], ma_list[1]
            fast, slow = sorted([(p1, k1), (p2, k2)])
            fid = add_ind(IndicatorSpec(id=f"{fast[1]}{fast[0]}", kind=fast[1], period=fast[0]))
            sid = add_ind(IndicatorSpec(id=f"{slow[1]}{slow[0]}", kind=slow[1], period=slow[0]))
            long_c.append(Condition(left=fid, op="crosses_above", right=sid))
            short_c.append(Condition(left=fid, op="crosses_below", right=sid))
            if direction is None:
                if cross_up and not cross_dn:
                    direction = "long"
                elif cross_dn and not cross_up:
                    direction = "short"
                else:
                    direction = "both"
        elif macd_m and re.search(r"macd[^.]{0,40}?(cross|above|below|over|under|positive|negative|bullish|bearish|turns)", entry_part):
            primary = "macd"
            mid = add_ind(IndicatorSpec(id="macd", kind="macd"))
            seg = entry_part[macd_m.start(): macd_m.start() + 60]
            down = re.search(r"below|under|negative|bearish|down", seg)
            if re.search(r"zero|\b0\b|centre|center", seg):
                direction = attach(Condition(left=mid, op="crosses_below" if down else "crosses_above", right=0.0))
            else:
                direction = attach(Condition(left=mid, op="crosses_below" if down else "crosses_above", right=f"{mid}.signal"))
        elif bb_m:
            primary = "bollinger"
            per = re.search(r"bollinger[^.]{0,12}?(\d{1,3})\s*[,/ ]\s*(\d(?:\.\d)?)", t)
            bid = add_ind(IndicatorSpec(id="bb", kind="bollinger", period=int(per.group(1)) if per else 20, multiplier=float(per.group(2)) if per else 2.0))
            band = "lower" if re.search(r"lower", entry_part) else "upper" if re.search(r"upper", entry_part) else ("upper" if bias() == "short" else "lower")
            # touching/closing outside the upper band = crossing above it; the lower band = crossing below it
            op = "crosses_above" if band == "upper" else "crosses_below"
            if re.search(r"back (inside|above|below)|re-?enter", entry_part):
                op = "crosses_below" if band == "upper" else "crosses_above"
            direction = attach(Condition(left="close", op=op, right=f"{bid}.{band}"))
        elif pd_m:
            primary = "prevday"
            pid = add_ind(IndicatorSpec(id="pd", kind="prevday"))
            lvl = pd_m.group(1) or {"h": "high", "l": "low"}[pd_m.group(2)]
            seg = entry_part[max(0, pd_m.start() - 30): pd_m.start()]
            down = re.search(r"below|under|breaks? down|breakdown", seg) or (lvl == "low" and not re.search(r"above|over", seg))
            direction = attach(Condition(left="close", op="crosses_below" if down else "crosses_above", right=f"{pid}.{lvl}"))
        elif rsi_m and re.search(r"rsi[^.]*?(below|under|above|over|crosses|<|>)\s*(\d{1,2})", entry_part):
            primary = "rsi"
            period = int(rsi_m.group(1) or 14)
            rid = add_ind(IndicatorSpec(id=f"rsi{period}", kind="rsi", period=period))
            m = re.search(r"rsi[^.]*?(below|under|above|over|<|>)\s*(\d{1,2})", entry_part)
            lvl = float(m.group(2))
            stated = Condition(left=rid, op="crosses_below" if m.group(1) in ("below", "under", "<") else "crosses_above", right=lvl)
            # The trade itself says which side the user means: buy call / buy shares = long, buy put / sell shares = short.
            bias = direction or ("short" if verb_short and instrument_type != "option" else "long")
            if bias == "short":
                short_c.append(stated)
                long_c.append(stated.mirrored())
            else:
                long_c.append(stated)
                short_c.append(stated.mirrored())
            direction = direction or bias
        elif st_m:
            primary = "supertrend"
            period = int(st_m.group(1) or 10)
            mult = float(st_m.group(2) or 3)
            sid = add_ind(IndicatorSpec(id="st", kind="supertrend", period=period, multiplier=mult))
            long_c.append(Condition(left=f"{sid}.dir", op="crosses_above", right=0))
            short_c.append(Condition(left=f"{sid}.dir", op="crosses_below", right=0))
            if direction is None:
                red = re.search(r"turns? red|bearish|flips? red", entry_part)
                green = re.search(r"turns? green|bullish|flips? green", entry_part)
                direction = "short" if red and not green else "long" if green and not red else "both"
        elif vwap_m:
            primary = "vwap"
            vid = add_ind(IndicatorSpec(id="vwap", kind="vwap"))
            if re.search(r"pull(?:s|ed|ing)?\s?back|retrace|touch|bounce", entry_part):
                long_c += [Condition(left="low", op="lte", right=vid), Condition(left="close", op="gt", right=vid)]
                short_c += [Condition(left="high", op="gte", right=vid), Condition(left="close", op="lt", right=vid)]
            else:
                long_c.append(Condition(left="close", op="crosses_above", right=vid))
                short_c.append(Condition(left="close", op="crosses_below", right=vid))
            if ma_list:
                k, p = ma_list[0]
                mid = add_ind(IndicatorSpec(id=f"{k}{p}", kind=k, period=p))
                long_c.append(Condition(left="close", op="gt", right=mid))
                short_c.append(Condition(left="close", op="lt", right=mid))
            if direction is None:
                direction = "short" if verb_short and instrument_type != "option" else "long"
        elif len(ma_list) == 1:
            primary = "ma1"
            k, p = ma_list[0]
            mid = add_ind(IndicatorSpec(id=f"{k}{p}", kind=k, period=p))
            long_c.append(Condition(left="close", op="crosses_above", right=mid))
            short_c.append(Condition(left="close", op="crosses_below", right=mid))
            if direction is None:
                direction = "long" if cross_up and not cross_dn else "short" if cross_dn and not cross_up else "both"

        # ---- extra AND filters on top of the main signal ("... and RSI > 55", "... while above VWAP") ----
        if long_c or short_c:
            def add_filter(c: Condition) -> None:
                long_c.append(c)
                short_c.append(c.mirrored())

            if primary != "rsi" and rsi_m:
                m = re.search(r"rsi\s*\(?\s*\d{0,2}\s*\)?\s*(?:is\s*|stays?\s*|remains?\s*)?(above|over|below|under|>=?|<=?)\s*(\d{1,2})", entry_part)
                if m:
                    period = int(rsi_m.group(1) or 14)
                    rid = add_ind(IndicatorSpec(id=f"rsi{period}", kind="rsi", period=period))
                    add_filter(Condition(left=rid, op="gt" if m.group(1) in ("above", "over", ">", ">=") else "lt", right=float(m.group(2))))
            if primary != "vwap" and vwap_m:
                m = re.search(r"(above|over|below|under)\s+(?:the\s+)?vwap", entry_part)
                if m:
                    vid = add_ind(IndicatorSpec(id="vwap", kind="vwap"))
                    add_filter(Condition(left="close", op="gt" if m.group(1) in ("above", "over") else "lt", right=vid))
            m = re.search(r"adx\s*\(?\s*(\d{1,2})?\s*\)?\s*(?:is\s*)?(above|over|>=?|below|under|<=?)\s*(\d{1,2})", entry_part)
            if m:
                period = int(m.group(1) or 14)
                aid = add_ind(IndicatorSpec(id=f"adx{period}", kind="adx", period=period))
                add_filter(Condition(left=aid, op="gt" if m.group(2) in ("above", "over", ">", ">=") else "lt", right=float(m.group(3))))
            if primary != "macd" and macd_m:
                m = re.search(r"macd\s*(?:line\s*)?(?:is\s*)?(positive|above\s*(?:zero|0)|bullish|above\s*(?:the\s*)?signal|negative|below\s*(?:zero|0)|bearish|below\s*(?:the\s*)?signal)", entry_part)
                if m:
                    mid = add_ind(IndicatorSpec(id="macd", kind="macd"))
                    up = re.search(r"positive|above|bullish", m.group(1))
                    right = f"{mid}.signal" if "signal" in m.group(1) else 0.0
                    add_filter(Condition(left=mid, op="gt" if up else "lt", right=right))
            if primary != "prevday":
                m = re.search(r"(above|over|below|under)\s+(?:the\s+)?(?:previous|prev|yesterday'?s?)\s*(?:day'?s?)?\s*(high|low|close)", entry_part)
                if m:
                    pid = add_ind(IndicatorSpec(id="pd", kind="prevday"))
                    add_filter(Condition(left="close", op="gt" if m.group(1) in ("above", "over") else "lt", right=f"{pid}.{m.group(2)}"))
            if primary in ("ma",) and len(ma_list) >= 3:
                m = re.search(r"(above|over|below|under)\s+(?:the\s+)?(\d{1,3})\s*-?\s*(ema|sma|dma)", entry_part)
                if m:
                    k = "sma" if m.group(3) == "dma" else m.group(3)
                    mid = add_ind(IndicatorSpec(id=f"{k}{m.group(2)}", kind=k, period=int(m.group(2))))
                    add_filter(Condition(left="close", op="gt" if m.group(1) in ("above", "over") else "lt", right=mid))

        # ---- things we can read but not run yet: say so instead of silently ignoring them ----
        used = {i.kind for i in indicators}
        UNSUPPORTED = [(r"\bmacd\b", "MACD") if "macd" not in used else (r"(?!)", ""),
                       (r"stochastic", "Stochastic"), (r"52\s*-?\s*week", "52-week levels"), (r"iron\s*(condor|fly|butterfly)", "iron condors / flies"),
                       (r"\bcpr\b|pivot", "pivot / CPR levels"), (r"\bgap\s*(up|down)", "gap rules")]
        unsupported = [label for pat, label in UNSUPPORTED if re.search(pat, t)]

        times = _find_times(t)
        fixed_time_entry = None
        if not long_c and not short_c:
            at = re.search(r"\bat\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?", entry_part)
            if at:
                fixed_time_entry = _norm_time(int(at.group(1)), int(at.group(2) or 0), at.group(3))
            if fixed_time_entry:
                long_c.append(Condition(left="time", op="at_time", right=fixed_time_entry))
                direction = direction or ("neutral" if option and option.mode.startswith(("straddle", "strangle")) else ("short" if verb_short and instrument_type != "option" else "long"))
                if direction == "short":
                    short_c, long_c = long_c, []
            else:
                if unsupported:
                    raise ValueError(f"{', '.join(unsupported)} {'is' if len(unsupported) == 1 else 'are'} not supported yet. "
                                     "Use EMA/SMA, RSI, VWAP, Supertrend, ADX, an opening range or a fixed entry time.")
                raise ValueError("Could not find an entry rule. Mention an indicator (EMA, SMA, RSI, VWAP, Supertrend), an opening range, or a fixed entry time.")
        if unsupported:
            warnings.append(f"Ignored {', '.join(unsupported)}: not supported yet. Check the rules before backtesting.")

        if direction is None:
            direction = "short" if verb_short and instrument_type != "option" else "long"
        if direction == "long":
            short_c = []
        elif direction == "short":
            long_c = []

        # ---- exits ----
        on_opposite = bool(re.search(r"opposite|reverse (?:cross|signal)|cross(?:es)? back|counter signal", t))
        if primary in ("ma", "ma1") and re.search(r"\bcross(?:es|ing|ed)?\b", exit_part):
            on_opposite = True  # "exit when it crosses below" = the opposite crossover
        if rsi_m and exit_part:
            m = re.search(r"rsi[^.]*?(above|over|below|under|>|<)\s*(\d{1,2})", exit_part)
            if m:
                rid = next((i.id for i in indicators if i.kind == "rsi"), None) or add_ind(IndicatorSpec(id=f"rsi{int(rsi_m.group(1) or 14)}", kind="rsi", period=int(rsi_m.group(1) or 14)))
                op = "crosses_above" if m.group(1) in ("above", "over", ">") else "crosses_below"
                exit_long.append(Condition(left=rid, op=op, right=float(m.group(2))))
                exit_short.append(Condition(left=rid, op="crosses_below" if op == "crosses_above" else "crosses_above", right=100 - float(m.group(2))))
        if st_m and re.search(r"turns? (red|green)|flips?", exit_part):
            exit_long.append(Condition(left="st.dir", op="crosses_below", right=0))
            exit_short.append(Condition(left="st.dir", op="crosses_above", right=0))
        if re.search(r"(close|price)\s*(?:goes\s*)?(below|under)\s*vwap", exit_part) and any(i.kind == "vwap" for i in indicators):
            exit_long.append(Condition(left="close", op="crosses_below", right="vwap"))
        if not (exit_long or exit_short) and not on_opposite and not re.search(r"stop|sl\b|target|tp\b", t) and direction != "neutral" and not fixed_time_entry:
            on_opposite = True
            warnings.append("No exit signal given; exiting on the opposite signal.")

        def pct(pattern: str) -> Optional[float]:
            m = re.search(pattern + r"\D{0,12}?(\d+(?:\.\d+)?)\s*(?:%|percent|pc\b)", t)
            return float(m.group(1)) if m else None

        sl = pct(r"(?:stop\s?-?\s?loss|\bsl\b|stoploss)")
        tgt = pct(r"(?:target|take\s?profit|\btp\b|profit target)")
        trail = pct(r"trail(?:ing)?\s*(?:stop|sl)?")
        if trail and sl == trail:
            sl = None

        def points(pattern: str) -> Optional[float]:
            m = re.search(pattern + r"\D{0,12}?(\d+(?:\.\d+)?)\s*(?:points?|pts?)\b", t)
            return float(m.group(1)) if m else None

        sl_pts = points(r"(?:stop\s?-?\s?loss|\bsl\b|stoploss)") if sl is None else None
        tgt_pts = points(r"(?:target|take\s?profit|\btp\b|profit target)") if tgt is None else None

        # ---- times: entry window & hard exit ----
        hard_exit = "15:15"
        win_start, win_end = "09:15", "15:00"
        for val, s0, _ in times:
            before = t[max(0, s0 - 30): s0]
            if fixed_time_entry and val == fixed_time_entry:
                continue
            if orb and val <= "10:30" and re.search(r"(range|from|between|to)\s*(the\s*)?(\d{1,2}[:.]\d{2}\s*(am)?\s*(to|-)\s*)?$", before):
                continue
            if re.search(r"(exit|square\s?off|close|by|or|hard exit|everything at|all at|before)\D{0,12}$", before) or val >= "14:45":
                hard_exit = val
            elif re.search(r"(no (new )?(entries|trades?) after|till|until|up to|upto|and)\D{0,6}$", before):
                win_end = val
            elif re.search(r"(after|from|between|start(ing)? at|post)\D{0,6}$", before):
                win_start = val
            elif val < "12:00" and not fixed_time_entry:
                win_start = val
        if fixed_time_entry:
            win_start = min(win_start, fixed_time_entry) if win_start != "09:15" else fixed_time_entry
        if orb:
            orb_end = next(i.end for i in indicators if i.kind == "orb")
            win_start = max(win_start, orb_end)
        if win_end >= hard_exit:
            win_end = _minus(hard_exit, 15)
        if win_start > win_end:
            win_start = win_end

        # ---- risk ----
        mt = re.search(r"max(?:imum)?\s*(?:of\s*)?(\d+)\s*(?:trades?|entries|positions?)|(\d+)\s*trades?\s*(?:a|per)\s*day|(one|two|three)\s+trades?\s*(?:a|per)\s*day", t)
        word = {"one": 1, "two": 2, "three": 3}
        max_trades = int(mt.group(1) or mt.group(2)) if mt and (mt.group(1) or mt.group(2)) else (word[mt.group(3)] if mt else 3)
        # "daily loss limit 5000", "max loss 2k", "rs 3000 daily loss" -- but never "stop loss 200 points"
        dl = re.search(r"(?<!stop )(?<!stop-)(?<!stop)(?:daily\s*)?(?:max(?:imum)?\s*)?loss\s*(?:limit|cap)?\s*(?:of|is|at)?\s*(?:rs\.?|inr)?\s*(\d[\d,]*)(?![\d,])(?!\s*(?:%|percent|pc\b|points?|pts?\b))(?:\s*(k|thousand|lakh|l)\b)?|(?:rs\.?|inr)\s*(\d[\d,]*)\s*(?:daily\s*)?loss", t)
        daily_cap = None
        if dl:
            v = _num(dl.group(1) or dl.group(3))
            unit = (dl.group(2) or "").lower()
            v *= 1000 if unit in ("k", "thousand") else 100000 if unit in ("lakh", "l") else 1
            if v >= 100:
                daily_cap = v
        lots_m = re.search(r"(\d+)\s*lots?\b|\blots?\s*(?:of\s*)?(\d+)|(?:qty|quantity)\s*(\d+)|(\d+)\s*(?:shares|qty)", t)
        lots = int(next(g for g in lots_m.groups() if g)) if lots_m else 1
        cap_m = re.search(r"capital\s*(?:of\s*)?(?:rs\.?)?\s*(\d[\d,]*)\s*(k|lakh|l)?", t)
        capital = 500000.0
        if cap_m:
            capital = _num(cap_m.group(1)) * {"k": 1e3, "lakh": 1e5, "l": 1e5}.get((cap_m.group(2) or "").lower(), 1)

        name = self._name(underlying, indicators, option, timeframe, fixed_time_entry)
        try:
            strategy = Strategy(
                name=name,
                description=raw,
                underlying=underlying,
                instrument_type=instrument_type,
                timeframe=timeframe,
                indicators=indicators,
                direction=direction,
                entry=EntryRules(long=long_c, short=short_c, logic="all"),
                exit=ExitRules(long=exit_long, short=exit_short, on_opposite_signal=on_opposite, stop_loss_pct=sl, target_pct=tgt, trailing_sl_pct=trail,
                               stop_loss_points=sl_pts, target_points=tgt_pts),
                entry_window=TimeWindow(start=win_start, end=win_end),
                hard_exit=hard_exit,
                option=option,
                risk=RiskSpec(lots=lots, max_trades_per_day=max_trades, daily_loss_cap=daily_cap, capital=capital),
                intraday=not re.search(r"\b(positional|swing|carry forward|overnight|delivery)\b", t),
            )
        except ValidationError as e:
            raise ValueError(f"Parsed rules were inconsistent: {e.errors()[0]['msg']}") from e
        conf = 0.9 - 0.1 * len(warnings)
        return ParseResult(strategy, "rules", warnings, round(max(0.3, conf), 2))

    @staticmethod
    def _name(underlying, indicators, option, timeframe, fixed_time) -> str:
        if any(i.kind == "orb" for i in indicators):
            core = "Opening Range Breakout"
        elif fixed_time and option:
            core = f"{option.mode.replace('_', ' ').title()} {fixed_time}"
        else:
            core = " / ".join(
                f"{i.kind.upper()} {i.period}" if i.period and i.kind != "supertrend" else ("Supertrend" if i.kind == "supertrend" else i.kind.upper())
                for i in indicators
            ) or "Custom"
            if sum(1 for i in indicators if i.kind in ("ema", "sma")) == 2:
                core += " crossover"
        return f"{underlying} {core} ({timeframe})"


def _minus(hhmm: str, minutes: int) -> str:
    h, m = map(int, hhmm.split(":"))
    tot = h * 60 + m - minutes
    return f"{tot // 60:02d}:{tot % 60:02d}"


def parse_strategy(text: str, use_llm: bool = True) -> ParseResult:
    """Parse with the LLM when configured, falling back to the deterministic parser."""
    if use_llm:
        from .llm import llm_available, llm_parse

        if llm_available():
            try:
                strategy = llm_parse(text)
                return ParseResult(strategy, "llm", [], 0.85)
            except Exception as e:  # network, quota, invalid JSON, schema mismatch
                res = RuleBasedParser().parse(text)
                res.warnings.insert(0, f"LLM parse failed ({type(e).__name__}); used rule-based parser.")
                return res
    return RuleBasedParser().parse(text)
