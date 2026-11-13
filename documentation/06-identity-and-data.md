# Identity, designations and network data

The tool has to answer three "what is this?" questions, and they are not the same
question:

| Question | Answer type | Owned by |
| --- | --- | --- |
| Where is this pole on the grid? | coordinate | `buildNetwork` |
| Which object is this, stably, across edits and reloads? | **asset id** | [geometry/assets.js](../src/geometry/assets.js) |
| What does a person call this pole on the sheet? | **designation** | [geometry/designations.js](../src/geometry/designations.js) |

Conflating them is the classic bug in this kind of tool: a name used as a key
renumbers when a route is inserted, and a coordinate used as a key loses a load when
the spacing changes. They are therefore kept separate, and the three are bridged only
through the asset registry.

## Contents

1. [Asset identity](#1-asset-identity)
2. [Stable identity across edits](#2-stable-identity-across-edits)
3. [Where designations come from](#3-where-designations-come-from)
4. [Span designations](#4-span-designations)
5. [Loads](#5-loads)
6. [Span length measurements](#6-span-length-measurements)
7. [Worked example: the same network, three identities](#7-worked-example-the-same-network-three-identities)
8. [Reconciliation when the drawing changes](#8-reconciliation-when-the-drawing-changes)
9. [Unresolved records](#9-unresolved-records)

---

## 1. Asset identity

An **asset** is a thing you can put a number on: a pole (node) or a span (edge).
Asset ids are strings, and their **prefix states what kind of thing they are**:

### Node asset ids

| Id | Meaning |
| --- | --- |
| `origin` | the Origin, whatever its marker kind |
| `dst:<routeId>` | the destination point created by that route |
| `mid:<routeId>:<k>` | the *k*-th intermediate pole along route `<routeId>`, `k` counting from 0 at the source |
| `endpoint:<letter>` | the endpoint registered under an alphabetical name (`endpoint:A`) |
| `tc:<n>` | the *n*-th TC point |
| `fpb:<n>` | the *n*-th FPB |

Several of these can denote **one physical pole**, and that is intentional. A route's
destination is reachable as `dst:route-2`, and if that point also received the letter
`B` it is reachable as `endpoint:B` too — the same coordinate under two aliases. The
registry resolves every alias to one **canonical** id (`canonicalNodeId()`), using the
first writer wins rule.

Note the corollary, which matters for anything that asks "is this the same point?":
**a route's destination id is not always a registered asset.** When two routes finish at
the same coordinate only the earlier route's `dst:<routeId>` exists, so
`canonicalNodeId('dst:<laterRoute>')` returns `null` while the route itself is perfectly
valid. Ask by coordinate (`canonicalNodeId(coordKey(point))`) in that situation, or treat
an unresolvable destination as unknown rather than as "different".

### Alias handling on read

Aliases are resolved **once**, where loads enter application state — in
`validateMeasuredData()` (`src/ui/project.js`), which already builds the registry — not
in each consumer. The parsed project therefore holds canonical ids, and the schedule
panel, the annotation layer, the reassignment picker and the saved project all agree
without any of them containing alias logic.

Only identifiers that **resolve** are rewritten:

| In the file | Parsed as | Why |
| --- | --- | --- |
| `dst:route-1` | `dst:route-1` | already canonical, unchanged |
| `0,-2` (coordinate alias) | `dst:route-1` | resolves through the registry |
| `dst:gone` | `dst:gone` | does not resolve — kept verbatim and warned about |

An unresolved reference is never deleted, nulled or reidentified, because a broken
reference is not an alias: it must stay legible so the user can reassign it, and the
existing reconciliation warning must still fire
([reconciliation](#8-reconciliation-when-the-drawing-changes)).
The caller's parsed JSON is not mutated either — the loads array is rebuilt.

### Span asset ids

```
<spanA>~<spanB>          e.g.  dst:route-1~mid:route-2:0
```

The two end asset ids joined by `~`. The order is the order the span was **first
drawn** in, and that is what a schedule shows as "from" and "to". Because the graph's
edges are canonical (sorted) but an asset id is directional, the registry keeps an
`edgeAliases` map so the reversed spelling resolves to the same span:
`canonicalSpanId('b~a') === 'a~b'`.

A span therefore has exactly **one length, one row and one id**, no matter how many
routes walked it or in which direction.

### What an asset carries

A node asset:

```js
{ id, kind:'node', coordKey, x, y,
  label,          // 'Origin', 'A', null   — the drawn letter, if any
  designation,    // 'Origin:1', 'A2', 'TC1' — what a person calls it
  nodeType,       // 'origin' | 'pole' | 'tc' | 'fpb'
  isOrigin }
```

A span asset:

```js
{ id, kind:'span', a, b, coordKey, fromKey, toKey,
  from, to,                       // asset ids of the ends
  fromNodeId, toNodeId,
  fromDesignation, toDesignation, // 'A1', 'A2'
  designation }                   // 'A1–A2'
```

## 2. Stable identity across edits

The registry's first-writer-wins rule plus the prefix scheme gives four properties the
UI depends on:

| Property | Consequence for the user |
| --- | --- |
| A coordinate reached by two routes keeps the **first** route's id | Editing a later route never steals an earlier route's loads |
| `mid:<routeId>:<k>` is positional within its own route | Inserting a route does not renumber another route's poles |
| An alias resolves to the canonical id | A record keyed `endpoint:B` still finds the pole now canonical as `dst:route-2` |
| `reconcile()` never reattaches | A load is never silently moved to a *different* pole that happens to reuse a name |

The last point is the important safety property. If a load's node disappears, it
becomes **unresolved** (§9) and the user decides. The tool never guesses.

`test/route_identity.test.js` (11 tests), `test/assets.test.js` and
`test/recovery.test.js` pin these.

## 3. Where designations come from

`allocateDesignations(network, seed)` is **pure**: no clock, no randomness, same input
always the same output. It names:

1. **Named points** — the Origin, every alphabetical endpoint, every TC, every FPB.
2. **Interior poles** — every other drawn node, from the named point it grows out of.

### The naming rule

| The pole grows out of | Its poles are named | Examples |
| --- | --- | --- |
| the Origin | `Origin:<n>` | `Origin:1`, `Origin:2`, … |
| an alphabetical point | `<letter><n>`, **no colon** | `A1`, `A2`, `A3` |
| a TC | `TC:<n>`, or `TC<k>:<n>` when there are several | `TC:1`; `TC2:1` |
| an FPB | `FPB:<n>`, or `FPB<k>:<n>` | `FPB:1`; `FPB2:1` |

Two separators, deliberately: `A1` reads as "the first pole after A" and `TC:1` reads
as "the first pole after TC". The colon is what keeps the *pole* `TC:1` (an ordinary
crossing) distinguishable from the *point* `TC` (a triangle) — and `A1` from a point
that might one day be called `A1`.

### Named points themselves

| Point | Name |
| --- | --- |
| Origin | always `Origin` |
| Alphabetical endpoints | `A`…`Z`, then `AA`, `AB`, … (bijective base-26, in creation order) |
| TC | `TC` when it is the only **TC destination**, else `TC1`, `TC2`, … |
| FPB | `FPB` when it is the only **FPB destination**, else `FPB1`, `FPB2`, … |

One precision worth knowing: numbering is by route **destination** count (`tcCount` /
`fpbCount`), not by how many such symbols appear on the sheet. An Origin declared an
FPB plus one FPB destination therefore still draws both boxes labelled `FPB`, because
there is one FPB destination. Verified by running `buildScene` on
`Origin(fpb) → South 1 → A → South 2 (FPB)`:

```
fpb boxes: [ 'FPB', 'FPB' ]   poles: 2   labels: [ 'A', 'Origin' ]
```

**An alphabetical letter is never given to a TC or an FPB.** That is what makes `A`
unambiguous; `showLabels` also never draws a letter on a marker node.

### Numbering behaviour

- **Per source point.** Each named point has its own counter, so `A1` and `B1` are
  unrelated poles.
- **Across branches.** Branching from `A` continues `A`'s sequence: `A1`, `A2`, `A3`
  can be on different branches.
- **Never reissued.** The allocator is seeded with the designations already stored and
  their derived counters (`countersFromDesignations`), so a name that belonged to a
  deleted pole is not handed to a new one. This is the whole reason designations are
  persisted rather than recomputed.
- **Deterministic order.** Numbering follows route order, then step order.
- **A named point that is also a destination is stored under both ids**
  (`endpoint:A` and `dst:route-N`), so neither looks nameless.

## 4. Span designations

`spanDesignation(from, to)` joins the two end designations with an **en dash**
`U+2013`, not a hyphen:

```
A1–A2          Origin–A          Origin:1–Origin:2          A2–TC          TC–TC:1
```

The orientation is the order the span was first drawn, which is also the order the
schedule shows it in. Because that orientation is stored, re-walking the same edge
backwards does not reverse the label — pinned by
[test/designations.test.js](../test/designations.test.js).

Span labels are what the drawing shows under the "span lengths" switch; the
designation itself is what the CSV and the schedule identify the row by.

## 5. Loads

A load is `{id, nodeId, value, unit}` ([data/schedules.js](../src/data/schedules.js)).

| Rule | Detail |
| --- | --- |
| Eligible points | `pole`, `fpb`, `origin` — `LOAD_ELIGIBLE_TYPES`. **A TC point is not eligible**, because a test point is a place you test the cable, not a place you tap it |
| Value | finite number `> 0`. Zero is refused rather than treated as blank |
| Units | `kVA`, `kW`, `kVAr`, `HP`; `normalizeUnit()` also accepts case variants. Default `kVA` (`DEFAULT_LOAD_UNIT`) |
| Summation | **none, ever** |
| Conversion | **none, ever** |
| Several loads on one pole | one callout with one line per load (`loadCalloutLines()`) |
| `nodeId` spelling | canonicalised on read ([above](#alias-handling-on-read)), so a coordinate alias is stored as the canonical id and still draws its callout |

The absence of totals and conversions is a design decision, not an omission: a
schedule of a mixed-unit installation is a list of what is *there*, and inventing a
total would require an assumption the tool refuses to make.

## 6. Span length measurements

A measurement is `{spanId, lengthM}` where `spanId` is the **span asset id**.

- **One row per unique physical span** — the file and the memory model both key by
  asset id, so "one physical edge, one length" holds in storage as well as on screen.
- `lengthM` is finite and `> 0`. A blank field means **unmeasured** — it removes the
  entry, rather than storing zero.
- **A length never moves the drawing.** It changes a label only. The label of an
  unmeasured span still prints, as `— m`.
- Units are metres; the drawing is not to scale (see
  [Route and geometry](04-route-and-geometry.md#2-span-to-distance-mapping)).

The default-length utility fills only unmeasured spans and reports
`{filled, skipped}`, so it can never overwrite typed data.

## 7. Worked example: the same network, three identities

Both tables below are the **verified output** of running
`buildNetwork` → `allocateDesignations` → `buildAssetRegistry`. Nothing is
hand-written.

### 7.1 A two-route chain

Rows: `1 Origin South 1`, `2 A East 4`.

| Coordinate | Asset id | Designation | Type | Drawn letter |
| --- | --- | --- | --- | --- |
| `0,0` | `origin` | `Origin` | origin | `Origin` |
| `0,-1` | `dst:route-1` | `A` | pole | `A` |
| `1,-1` | `mid:route-2:0` | `A1` | pole | — |
| `2,-1` | `mid:route-2:1` | `A2` | pole | — |
| `3,-1` | `mid:route-2:2` | `A3` | pole | — |
| `4,-1` | `dst:route-2` | `B` | pole | `B` |

Spans, in the orientation each was first drawn:

| Span id | Designation |
| --- | --- |
| `dst:route-1~origin` | `Origin–A` |
| `dst:route-1~mid:route-2:0` | `A–A1` |
| `mid:route-2:0~mid:route-2:1` | `A1–A2` |
| `mid:route-2:1~mid:route-2:2` | `A2–A3` |
| `dst:route-2~mid:route-2:2` | `A3–B` |

Note `A`'s column: the *point* is `A`, and its poles are `A1`, `A2`, `A3` — while the
Origin's poles would be `Origin:1`, `Origin:2`.

### 7.2 Markers in a chain

Rows: `1 Origin South 1`, `2 A South 3 TC`, `3 TC South 3`, `4 B East 2 FPB`.

| Asset id | Designation | Type |
| --- | --- | --- |
| `origin` | `Origin` | origin |
| `dst:route-1` | `A` | pole |
| `mid:route-2:0` | `A1` | pole |
| `mid:route-2:1` | `A2` | pole |
| `dst:route-2` | `TC` | tc |
| `mid:route-3:0` | `TC:1` | pole |
| `mid:route-3:1` | `TC:2` | pole |
| `dst:route-3` | `B` | pole |
| `mid:route-4:0` | `B1` | pole |
| `dst:route-4` | `FPB` | fpb |

Counters produced: `A: 3`, `TC: 3`, `B: 2` — i.e. the next pole after `A` is `A3`,
after `TC` is `TC:3`, after `B` is `B2`.

Span designations include `A2–TC`, `TC–TC:1`, `TC:1–TC:2`, `TC:2–B`, `B–B1`,
`B1–FPB`. The TC triangle and the FPB box each take the place of a pole **and** of an
X, and the spans meet them by name, not by coordinate.

## 8. Reconciliation when the drawing changes

`reconcile(liveAssets, loads, spanLengths)` returns
`{unresolvedLoads, unresolvedSpans}` — the records whose asset is gone.

Rules:

1. **A record is matched by asset id**, never by designation, position or index. Alias
   resolution has already happened by this point: records arrive from
   `validateMeasuredData()` holding canonical ids, so a coordinate alias never reaches the
   comparison as a raw string ([alias handling on read](#alias-handling-on-read)).
2. **A record that matches nothing is reported, not dropped and not moved.** The
   number the user typed is their data.
3. **A record is never attached to a lookalike.** If `A3` disappears and a new pole is
   later allocated the next unused number, no old load silently lands on it.

That third rule is why the allocator never reissues a name: if names *were* reused, a
stale reference would silently become a reference to a different physical pole, which
would be worse than an unresolved row.

## 9. Unresolved records

An unresolved record is visible, not hidden:

- **In the node-load table:** shown with `— (missing)` and `is-unresolved` styling, and
  a **Reassign** button that offers a numbered list of eligible points and moves the
  record, keeping its id and value (`reassignLoad()`).
- **In the span table:** shown at the bottom as `— (not in drawing)` with a status of
  `not in drawing`, so a length the user typed stays visible.
- **In the imports:** a CSV row naming a node or span the drawing does not have is
  reported in `#import-details` and counted in `#import-summary`, and is **not** a
  reason to refuse the file (only genuinely malformed rows are).
- **In a project file:** kept, and reported as a load/span-length warning on open.
- **In the drawing itself:** not drawn at all — an unresolved record has no position,
  so it produces no callout and no label. It is visible only in the schedules, which is
  where the user can act on it.

`renderUnresolved()` drives `#unresolved-bar` in the Network data panel, which states
how many loads and how many span lengths refer to points or spans the drawing no
longer has — e.g. "2 loads and 1 span length refer to points or spans this drawing no
longer has. They are kept until you reassign or discard them, so nothing you recorded
has been lost." The bar is hidden when the count is zero and offers two actions:

- `#btn-unresolved-review` — switches to the loads tab and scrolls the first
  unresolved row into view, selecting its point.
- `#btn-unresolved-discard` — removes **all** unresolved loads and lengths after a
  confirm that states the count, because it cannot be undone.
