"""Deterministic report enrichment shared by the local and browser engines."""
from . import health, levels, quality, sequence, special
from . import rules as extra_rules
# 补充规则单列在这里：引擎 config.rules 仍然只列引擎自己执行的规则，
# 前端靠这份清单判断「设计检查」页该展示哪几条。
EXTRA_RULE_IDS = (levels.RULE_SRP, levels.RULE_OCP, levels.RULE_LSP, levels.RULE_ISP,
                  levels.RULE_DIP, levels.RULE_A5_DEAD, levels.RULE_A8_DEFENSIVE)


def _register_extra_rules(merged):
    config = merged.get("config")
    if not isinstance(config, dict):
        config = {}
        merged["config"] = config
    ids = [item for item in (config.get("rules") or []) if isinstance(item, str)]
    for rule_id in EXTRA_RULE_IDS:
        if rule_id not in ids:
            ids.append(rule_id)
    config["rules"] = ids


def merge_extra(result):
    """把补充规则（S/O/D、死代码、防御式捕获）并入引擎结果，返回 (merged, extra)。

    只新增 findings 与 config.rules 里的规则名，不改动引擎已产出的键值。
    """
    extra = extra_rules.evaluate(result)
    merged = extra_rules.merge(result, extra)
    _register_extra_rules(merged)
    merged["extra_rules"] = {
        "findings": len(extra.get("findings") or []),
        "metrics": extra.get("metrics") or {},
        "notes": list(extra.get("notes") or []),
    }
    return merged, extra


def enrich(result):
    """analyze() 之后补齐三样前端需要的派生数据：补充规则、健康度得分、时序序列。

    三者都是确定性计算，不含模型、不含随机；analyze() 本身的返回契约不受影响。
    """
    if not isinstance(result, dict) or result.get("status") in ("empty", "failed"):
        return result
    merged, _ = merge_extra(result)
    merged = quality.apply(merged)
    merged["limitations"] = ["静态分析不执行源码；动态调用与运行时行为无法完整还原。", *extra_rules.NOTES, *quality.NOTES]
    merged = health.apply(merged)
    merged["sequence"] = sequence.build(merged)
    merged["special_risks"] = special.build(merged)
    return merged
