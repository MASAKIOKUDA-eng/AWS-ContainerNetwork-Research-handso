#!/usr/bin/env python3
"""Summarize results/k6.csv (median over repeated runs) as Markdown tables for the slides.

  python3 scripts/summarize.py results/k6.csv                       # all metrics
  python3 scripts/summarize.py results/k6.csv --metrics total_p50_ms,total_p99_ms,error_rate
  python3 scripts/summarize.py results/k6.csv --pivot total_p99_ms   # paths x load, one metric
"""
import argparse
import csv
import statistics
from collections import defaultdict


def main():
    p = argparse.ArgumentParser()
    p.add_argument("csv")
    p.add_argument("--metrics", default="")
    p.add_argument("--pivot", default="", help="one metric: rows=path/ip/reuse, columns=load")
    a = p.parse_args()
    wanted = {m for m in a.metrics.split(",") if m}

    groups = defaultdict(list)
    with open(a.csv, newline="") as f:
        for row in csv.DictReader(r for r in f if not r.startswith("#")):
            try:
                v = float(row["value"])
            except (ValueError, KeyError):
                continue
            key = (row["path"], row["mode"], row["ip"], row["reuse"], row["load"], row["metric"])
            groups[key].append(v)

    if a.pivot:
        loads = sorted({k[4] for k in groups if k[5] == a.pivot}, key=lambda s: (len(s), s))
        rows = sorted({k[:4] for k in groups if k[5] == a.pivot})
        print(f"### {a.pivot} (median of runs)\n")
        print("| path | mode | ip | reuse | " + " | ".join(loads) + " |")
        print("|---|---|---|---|" + "---|" * len(loads))
        for r in rows:
            cells = []
            for ld in loads:
                v = groups.get((*r, ld, a.pivot))
                cells.append(f"{statistics.median(v):.2f}" if v else "")
            print("| " + " | ".join(r) + " | " + " | ".join(cells) + " |")
        return

    print("| path | mode | ip | reuse | load | metric | n | median | min | max |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for key in sorted(groups):
        if wanted and key[5] not in wanted:
            continue
        v = groups[key]
        print("| " + " | ".join(key) + f" | {len(v)} | {statistics.median(v):.3f} | {min(v):.3f} | {max(v):.3f} |")


if __name__ == "__main__":
    main()
