"""Attribute a V8 snapshot's exclusive AppServer Thread-cache graph.

Usage: python3 scripts/attribute-inactive-history.py <snapshot> ...
This sums V8 self_size reachable only through ZenAppServer.#threads after
excluding weak edges. It is not RSS, external Buffer size, or macOS footprint.
"""

import json
import sys


def attribute(filename):
    with open(filename, encoding="utf-8") as source:
        snapshot = json.load(source)
    meta = snapshot["snapshot"]["meta"]
    nodes, edges, strings = (snapshot[key] for key in ("nodes", "edges", "strings"))
    node_fields, edge_fields = meta["node_fields"], meta["edge_fields"]
    node_types, edge_types = meta["node_types"][0], meta["edge_types"][0]
    width, edge_width = len(node_fields), len(edge_fields)
    node_count = len(nodes) // width
    starts = [0] * (node_count + 1)
    edge_offset = 0
    cache_edges, threads = set(), []
    for index in range(node_count):
        offset = index * width
        starts[index] = edge_offset
        count = nodes[offset + node_fields.index("edge_count")]
        name = strings[nodes[offset + node_fields.index("name")]]
        kind = node_types[nodes[offset + node_fields.index("type")]]
        if kind == "object" and name == "Thread":
            threads.append(index)
        if kind == "object" and name == "ZenAppServer":
            for edge in range(edge_offset, edge_offset + count * edge_width, edge_width):
                if (edge_types[edges[edge]] == "property"
                        and strings[edges[edge + 1]] == "#threads"):
                    cache_edges.add(edge)
        edge_offset += count * edge_width
    starts[node_count] = edge_offset
    if len(cache_edges) != 1:
        raise ValueError("Expected exactly one ZenAppServer.#threads edge")

    def reachable(removed):
        seen = bytearray(node_count)
        seen[0] = 1
        todo = [0]
        while todo:
            index = todo.pop()
            for edge in range(starts[index], starts[index + 1], edge_width):
                if edge in removed or edge_types[edges[edge]] == "weak":
                    continue
                target = edges[edge + 2] // width
                if not seen[target]:
                    seen[target] = 1
                    todo.append(target)
        return seen

    before, after = reachable(set()), reachable(cache_edges)
    size_field = node_fields.index("self_size")
    return {
        "snapshot": filename,
        "threadObjects": len(threads),
        "strongThreadObjects": sum(before[index] for index in threads),
        "exclusiveHostCacheBytes": sum(
            nodes[index * width + size_field]
            for index in range(node_count) if before[index] and not after[index]
        ),
        "exclusiveThreadObjects": sum(
            before[index] and not after[index] for index in threads
        ),
        "method": "Strong reachability difference after removing ZenAppServer.#threads; weak edges excluded; V8 self_size only",
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for filename in sys.argv[1:]:
        print(json.dumps(attribute(filename)))
