# Route and geometry model

This document describes the mathematical and structural representation of the
network: how a route instruction becomes a canonical graph, how that becomes pixels,
and how the marker symbols are constructed and clipped.

Authoritative modules: [src/geometry/direction.js](../src/geometry/direction.js),
[src/geometry/graph.js](../src/geometry/graph.js),
[src/geometry/network.js](../src/geometry/network.js),
[src/geometry/markers.js](../src/geometry/markers.js),
[src/geometry/scene.js](../src/geometry/scene.js),
[src/config.js](../src/config.js).

## Contents

1. [Coordinate system](#1-coordinate-system)
2. [Span-to-distance mapping](#2-span-to-distance-mapping)
3. [Pole positions versus spans](#3-pole-positions-versus-spans)
4. [Route sequencing and dependency resolution](#4-route-sequencing-and-dependency-resolution)
5. [Canonical graph construction](#5-canonical-graph-construction)
6. [Sharing, overlap and junctions](#6-sharing-overlap-and-junctions)
7. [Pole X symbol](#7-pole-x-symbol)
8. [TC triangle geometry](#8-tc-triangle-geometry)
9. [FPB rectangle geometry](#9-fpb-rectangle-geometry)
10. [Marker anchoring and cable connectivity](#10-marker-anchoring-and-cable-connectivity)
11. [Clipping: no cable inside a symbol](#11-clipping-no-cable-inside-a-symbol)
12. [Normalized scene construction](#12-normalized-scene-construction)
13. [Worked examples](#13-worked-examples)

---

## 1. Coordinate system

The convention is fixed and global, and is stated at the top of
[direction.js](../src/geometry/direction.js):

```
Origin = (0, 0)
North = +Y     South = −Y
East  = +X     West  = −X
One span = one integer grid unit.
```

`DIRECTIONS` in [config.js](../src/config.js) carries the deltas:

| key | dx | dy | label |
| --- | --- | --- | --- |
| `north` | 0 | +1 | North |
| `south` | 0 | −1 | South |
| `east` | +1 | 0 | East |
| `west` | −1 | 0 | West |

`normalizeDirection()` accepts either the key or the label, case-insensitively, via
`DIRECTION_ALIASES`; anything else returns `null`, which the validator turns into
`ERROR_CODES.UNKNOWN_DIRECTION`.

**Vertical flip in pixel space.** SVG and PDF user space grows downward, so the
scene maps grid Y to pixels inverted:

```js
x_px = (x − bbox.minX) · spanLength + padding
y_px = (bbox.maxY − y) · spanLength + padding
```

That is `gridToPixel()` in [scene.js](../src/geometry/scene.js). Its consequence for
markers is that a grid direction and a *pixel* direction are not the same vector:
`pixelDirectionVector('south')` is `{dx: 0, dy: +1}` — down the screen. Markers are
drawn in pixels, so they use `pixelDirectionVector`, not the grid vector.

Worked example: the bundled example drawing's Origin is at grid `(0,0)`, and its
first route goes South 1 span to `(0,−1)`. At spacing 40 with `exportPadding = 28`
and the example's bounding box `minX=0, maxX=12, minY=−17, maxY=0`, the Origin
renders at pixel `(28, 28)` and the next pole at `(28, 68)` — below it on screen,
because South is −Y in grid space and +Y in pixel space. (Verified by running
`buildNetwork` + `buildScene` on the example rows.)

## 2. Span-to-distance mapping

Three different *lengths* exist and must not be confused:

| Length | Unit | Source | Changes when |
| --- | --- | --- | --- |
| **Graphical span spacing** | px per span | `state.spanLength` (default 40, UI clamp 12…120) | the user changes the spacing |
| **Physical measured span length** | m | `state.spanLengths` (a survey) | the user measures a span |
| **Drawing scene dimension** | px | `measureDrawing(bbox, config, padding)` | the spacing, the network extent or the padding changes |

`measureDrawing()` computes:

```js
contentWidth  = (bbox.maxX − bbox.minX) · spanLength
contentHeight = (bbox.maxY − bbox.minY) · spanLength
width  = contentWidth  + padding·2
height = contentHeight + padding·2
```

`padding` is `viewPadding` (36 px) for the `preview` profile and `exportPadding`
(28 px) for `pdf`, `svg` and `print`.

**A measured length never feeds back into geometry.** Changing a length changes a
label; changing the spacing changes coordinates but never topology.

### Equal graphical spacing

Every span is drawn with exactly the same pixel length, whatever its physical
measurement. The drawing is therefore a **topological and structural** drawing, not
a scale drawing. This is why the TC/FPB clipping rules matter so much: the only thing
a reader can measure from the sheet is the pole count.

## 3. Pole positions versus spans

A route of `N` spans produces:

- `N` unit edges, therefore `N` unit-span lengths of line (some trimmed by markers),
- `N + 1` pole positions counting the source — but the two end positions are
  whichever named endpoints they coincide with,
- `N − 1` poles *between* the ends when both ends are already named points.

That last figure is the one that matters for naming: **one designation per actual
pole, not per span** (see [Identity and network data](06-identity-and-data.md#3-where-designations-come-from)).
In the example, route 2 (`A` → East 4) draws four edges, and its three interior
points become `A1`, `A2`, `A3`; the far end becomes `B`.

`test/geometry.test.js` test 2 pins "N spans produce N unit edges and N+1 pole
positions including the source".

## 4. Route sequencing and dependency resolution

`buildNetwork()` walks the instruction list **once, in order**. For each row:

1. **Shape validation** (`validateShapes`) — the row is an object, `from` is
   non-empty, the direction normalises, `spans` is a finite integer > 0, and `tc` and
   `fpb` are not both set.
2. **Source resolution** — `registry.resolve(route.from)` accepts either an internal
   id or a display name (lower-cased). If it fails, the error names the original
   cause when an *earlier* row failed, rather than blaming this row.
3. **Walking** — `spans` unit steps are applied with `advance()`, each producing one
   `addEdge()` call with provenance
   `{routeId, row, fromId, direction, spanIndex, fromKey}`.
4. **Destination resolution** — the arrival coordinate is matched against every
   endpoint already created. A match **reuses** that endpoint; otherwise a new one is
   created as `fpb`, `tc` or an alphabetical `endpoint`.
5. **Upgrade** — if a coordinate already carried an ordinary endpoint and this route
   asks for TC or FPB, the endpoint's `kind` is upgraded in place, so the coordinate
   is one point with one symbol.

`resolved[]` records, per row, whether it succeeded and what it created. That is what
lets a later failure point at the original cause:

> `Route 4: its starting point cannot exist because route 3 did not resolve.`

Because a failed row creates no destination, dependent rows fail too, but they are
**kept**, so editing the cause restores the whole chain deterministically.

### Naming projection

After the walk, endpoint naming is projected onto graph nodes:

- Origin → `displayName: 'Origin'`, `node.isOrigin = true`. If the Origin was
  declared TC/FPB, the node also gets `tcId`/`tcName = 'TC'` or `fpbId`/`fpbName =
  'FPB'`, and `markerDirection = null`.
- Endpoint → `node.alphaLabel = name`, `displayName = name`.
- TC → `displayName` is `endpoint.name` when several TCs exist, otherwise `'TC'`;
  `node.tcId`, `node.tcName`, `node.markerDirection = createdByDirection`.
- FPB → same rule with `fpbId`, `fpbName`, `'FPB'`.

Alphabetical labels come from `alphaLabel(index)`: `A…Z, AA, AB, …` (a spreadsheet-style
bijective base-26), assigned in creation order — see
[Identity and network data](06-identity-and-data.md).

`computeBoundingBox(graph)` returns the integer box over all nodes, seeded at
`(0,0)` so an empty network still has a usable box.

## 5. Canonical graph construction

[graph.js](../src/geometry/graph.js) holds two maps.

### Nodes

Keyed by `coordKey(position)` = `"x,y"`. `ensureNode()` creates, on first use:

```js
{ id: 'n1', key: '3,-2', x: 3, y: -2, neighbors: Set,
  isOrigin: false, alphaLabel: null, tcId: null, tcName: null,
  fpbId: null, fpbName: null, markerDirection: null }
```

Rationale: *a coordinate says where a pole is drawn.* Nodes are therefore merged by
coordinate, which is why two routes arriving at the same point produce one pole with
one X.

### Edges

Undirected, canonicalised by `edgeKey(a, b)`, which sorts the two coordinate strings
and joins them with `|`:

```js
edgeKey({x:1,y:0}, {x:2,y:0}) === '1,0|2,0'
edgeKey({x:2,y:0}, {x:1,y:0}) === '1,0|2,0'
```

`addEdge()` creates the edge on first traversal (adding both neighbours) and on every
traversal pushes one provenance record. So **one physical edge accumulates many
sources** — one per route/step that walked it — and `edgeRouteCount(edge)` counts the
distinct route ids.

## 6. Sharing, overlap and junctions

| Situation | Graph outcome | Drawing outcome |
| --- | --- | --- |
| Two routes start from the same endpoint | one node; `usedAsSource` on both | one pole, one X |
| Two routes end at the same coordinate | one node; the second reuses the endpoint | one pole, one symbol |
| Partial overlap (routes share some spans) | the shared edges are merged; only the non-shared edges are new | the shared cable is drawn once |
| Complete overlap (same path both ways) | every edge merged, canonical key identical | drawn exactly once |
| Perpendicular crossing | the crossing coordinate becomes a node of degree 4 | a junction pole is drawn there |
| Branch from a mid-run pole | not expressible: `from` must be an existing *endpoint* | a branch must start from a named point |

Note the last row: a branch can only start from the Origin or from a route's
destination. There is no "branch from pole A2" affordance. This is a deliberate,
verified limit (see [Known limitations](10-limitations.md)).

`test/geometry.test.js` tests 6–10 pin shared endpoints, partial overlap, complete
overlap, intersecting junctions (test 9, "intersecting routes become connected
junctions") and multiple branches (test 10). `test/assets.test.js` test 4
plus `test/annotations.test.js` test 25 pin that a shared node is one asset and one
callout.

## 7. Pole X symbol

A pole is drawn as a crossing of two diagonal strokes of half-size
`DEFAULT_CONFIG.poleMarkerSize = 4.5 px`. The path data is generated once, in
[render/svg.js](../src/render/svg.js):

```js
poleCrossPath({x, y, size}) =>
  `M${x-size} ${y-size}L${x+size} ${y+size}` +
  `M${x+size} ${y-size}L${x-size} ${y+size}`
```

The PDF renderer parses that same path (`parsePairedPath()`) and strokes each segment
through the page transform, so the X in the PDF is the X in the SVG.

A pole is **suppressed** wherever a TC or FPB marker is drawn: `buildScene` skips the
X when `node.tcId`/`node.fpbId` is set *and* the active profile draws that marker
kind. A node never receives two symbols.

## 8. TC triangle geometry

Reference: `tcTriangleVertices()`, `tcTrianglePoints()`, and `TC_APEX_INSET` in
[markers.js](../src/geometry/markers.js).

### Size

| Config key | Default | Meaning |
| --- | --- | --- |
| `tcMarkerSize` | 12 | half-width of the base at default spacing |
| `tcMarkerHeight` | 20 | apex-to-base distance |
| `tcMaxSpanFraction` | 0.75 | largest share of one span the triangle may occupy |

At and above the default spacing the configured size is used unchanged. Below it,
`buildScene` computes

```js
tcScale  = min(1, spanLength · tcMaxSpanFraction / tcMarkerHeight)
fitScale = (room − minVisibleLineLength) / tcMarkerHeight     // room = distance to the nearest upstream marker
scale    = min(tcScale, fitScale)
```

so the triangle can only ever shrink, never grow, and always leaves at least
`minVisibleLineLength = 6 px` of readable cable when a marker sits immediately
upstream. When nothing is within a span, `room` is `Infinity` and `fitScale` is 1.

### Orientation and anchoring

The triangle is anchored on its **downstream base midpoint**, which *is* the node
coordinate, and extends **backwards** over the cable that feeds it:

```js
forward  = pixelDirectionVector(direction ?? 'south')   // the route direction that created the point
upstream = { dx: −forward.dx, dy: −forward.dy }         // towards the apex
across   = { dx: −upstream.dy, dy: upstream.dx }        // perpendicular, for the base corners

apex      = (x + upstream.dx·height,  y + upstream.dy·height)
baseRight = (x + across.dx·halfWidth, y + across.dy·halfWidth)
baseLeft  = (x − across.dx·halfWidth, y − across.dy·halfWidth)
```

`direction` is the direction of the route that **first created** the point (stored
on the endpoint as `createdByDirection` and projected to `node.markerDirection`). A
point with no route arriving at it — the Origin declared a TC — falls back to
`DEFAULT_MARKER_DIRECTION = 'south'`, whose apex is up the sheet.

Why the base sits on the node: a TC arrives on one route and continues on the next,
and **both of those spans are drawn as full configured spans**. If the marker
occupied any of the outgoing span, the visible cable below the TC would be shorter
than the pole spacing, and a reader measuring the sheet would get the wrong answer.
This was corrected in commit `dca41d5` (*"anchor the triangle on its downstream
base, so the leaving span stays whole"*); `test/tc_anchor.test.js` (12 tests) and the
browser suite's per-layout check *"the printed leaving span equals the configured
spacing"* pin it.

### Worked example

Route goes South (grid) one span into a TC. `forward = (0, +1)` (pixel down),
`upstream = (0, −1)`. At default size the vertices are

```
apex      = (x,     y − 20)
baseRight = (x + 12, y)
baseLeft  = (x − 12, y)
```

The incoming cable (from the north, i.e. above) is trimmed at the apex, inside the
triangle is left empty, and the leaving cable starts at the base midpoint — which is
the node — so the next pole is a full span below.

## 9. FPB rectangle geometry

Reference: `createFpbPrimitive()` in [scene.js](../src/geometry/scene.js) and
`fpbRectVertices()` in `markers.js`.

The box is **sized from its own label**, not from the spacing, because shrinking it
would make the text overflow:

```js
textWidth = String(fpbText).length · fpbFontSize · 0.62   // measureFpbText
boxWidth  = textWidth + fpbPaddingX·2
boxHeight = fpbFontSize + fpbPaddingY·2
boxX = x − boxWidth/2        // centred on the anchor
boxY = y − boxHeight/2
```

With the defaults (`FPB`, 11 px, padding 4/2.5): `textWidth ≈ 20.46`, so the box is
about **28.46 × 16 px**, centred on the node. The `0.62` factor is deliberately
generous for Helvetica/Arial — an over-wide box looks right, a tight one clips.

Because the box is *not* scaled with spacing, it is the only marker that can exceed
the gap, which is what drives the clearance policy (see §12 and
[Rendering](07-rendering-and-export.md#7-span-spacing-and-clearance)).

`fpbRectVertices()` returns the four corners clockwise from the top-left, read
straight from the same primitive the renderers draw, so the hole left in the line and
the rectangle drawn can never disagree.

## 10. Marker anchoring and cable connectivity

| Symbol | Anchor | Extends | Replaces X? |
| --- | --- | --- | --- |
| Pole | node centre | `±poleMarkerSize` in all four directions | — |
| TC triangle | **base midpoint** = node | `height` backwards (upstream) along the route axis; `halfWidth` laterally | yes |
| FPB box | node centre | `±halfWidth` horizontally, `±halfHeight` vertically | yes |

The two anchorings differ on purpose: a symmetric symbol is centred, an oriented
symbol is placed so its orientation is meaningful and never eats the outgoing span.

## 11. Clipping: no cable inside a symbol

`clipSegmentOutsidePolygon(x1, y1, x2, y2, vertices)` in
[markers.js](../src/geometry/markers.js) is the single clipping routine, applied to
both TC triangles and FPB rectangles.

Algorithm:

1. Parameterise the segment `P(t) = start + t·(end − start)`.
2. Collect every `t` where the segment crosses a polygon edge, plus `t = 0` and
   `t = 1`.
3. Sort the cuts; for each interval take its midpoint and test it with an even-odd
   point-in-polygon test.
4. Emit the maximal runs whose midpoint is **outside** the polygon.
5. Drop pieces shorter than `1e-6`.

Properties, all pinned by tests (`test/tc_clip.test.js`, `test/fpb_clip.test.js`):

- A line that misses the polygon is returned unchanged.
- A line wholly inside is dropped.
- Clipping never lengthens a line and never moves its endpoints.
- The visible pieces still *meet* the symbol boundary, so the connection reads as
  continuous.
- The operation is on **pixel coordinates in the scene**. The canonical graph and its
  topology are never modified.

`buildScene` applies clipping in a single pass over all marker holes, so the order in
which markers are drawn cannot change the result, and the *clipped* lines become the
`lines[]` the annotation layer also uses as obstacles. A split line keeps one
`parentId`, so the drawing can still be counted in route edges.

## 12. Normalized scene construction

`buildScene(network, profile, configOverrides, data)` performs, in this exact order:

1. Resolve the profile (`resolveProfile`) and the config (`createConfig`).
2. Compute the bounding box and `measureDrawing()` with the profile's padding.
3. Build `toPixel()` from `gridToPixel`.
4. Compute the TC scale caps (§8).
5. **Resolve every marker primitive first** into `tcShapes` and `fpbShapes`, each
   with its `vertices`. Nothing can be trimmed against a shape that does not exist yet.
6. Build `holes = [...tcShapes, ...fpbShapes]` and clip every edge against every hole,
   emitting one scene `line` per visible piece.
7. Build `labelSlots` (origin + alphabetical labels, *unfiltered*) and the
   profile-filtered `labels`, the `poles` (skipping marker anchors) and `junctions`.
8. Sort `lines`, `poles`, `tc`, `fpb` by x-then-y and `labels` by id, so the output is
   deterministic.
9. Build the **annotation layer** last, with every symbol, line and label known. Its
   own layout is computed in an unpadded frame and then shifted by the scene padding,
   so the same project places the same callout in the preview and on the sheet.

`labelSlots` is built regardless of the profile on purpose: exports draw no letters,
but the space those letters occupy is still part of where an annotation may go.
Removing it from the equation would make one project place its callouts differently
in the preview and in the exports.

### Scene size with the bundled example

| spacing | scene width × height (print/pdf/svg) | preview |
| --- | --- | --- |
| 40 (default) | 536 × 736 | 552 × 752 |
| 60 | 776 × 1076 | — |
| 100 | 1256 × 1756 | — |

The scene is always **taller than it is wide** for the example, which is why the print
fit binds on height. See the `c39eca9` regression in
[Rendering and export](07-rendering-and-export.md#6-regression-history).

## 13. Worked examples

### 13.1 A single chain

```
1  Origin  South 1
2  A       East  4
```

```
grid:  Origin(0,0) → South 1 → A(0,−1)         (endpoint A)
       A(0,−1)    → East 4  → B(4,−1)         (endpoint B, 3 interior poles)
```

- 5 edges, 6 nodes, 4 X poles and the Origin.
- `A` is the destination of route 1, `B` of route 2.
- Interior poles of route 2 are `A1(1,−1)`, `A2(2,−1)`, `A3(3,−1)` — named from the
  *source* `A`, numbered outward in route order.
- Span names, in the orientation each was first drawn: `Origin–Origin:1`,
  `Origin:1–A`, `A–A1`, `A1–A2`, `A2–A3`, `A3–B`.

Verified by running `buildNetwork` → `allocateDesignations` → `buildAssetRegistry`
on exactly these two rows; the node table and the span table that run produced are
reproduced in [Identity and network data](06-identity-and-data.md#7-worked-example-the-same-network-three-identities).
- Verified by running `buildNetwork` + `allocateDesignations` + `buildAssetRegistry`;
  pinned by `test/designations.test.js` tests 1–3.

### 13.2 A branch and a shared edge

```
1  Origin  South 2      → A(0,−2)
2  A       East  3      → B(3,−2)
3  A       North 2      → C(0,0)   ← arrives at the Origin's coordinate
```

- Route 3's unit edges run `(0,−2)→(0,−1)` and `(0,−1)→(0,0)`.
- Both of those edges were already drawn by route 1, so the canonical keys are
  identical and both edges are **merged**: two lines in total for the branch, each
  with two provenance records.
- `(0,0)` already carries the Origin endpoint, so route 3's destination **reuses**
  it; no new endpoint, no new letter — the endpoints of this network are just
  `Origin`, `A`, `B`.
- No new junction is created here: `(0,−2)` is `A` with degree 3 (Origin side, `B` side,
  branch side), but `showJunctionMarkers` is false in every profile, so no junction
  symbol is drawn — `A` keeps an ordinary X.
- **A branch that starts from an intermediate pole is not expressible.** Only named
  points can be a `from`; there is no way to say "branch east from `A2`". See
  [Known limitations](10-limitations.md#1-a-branch-can-only-start-from-a-named-point).
- `test/geometry.test.js` tests 6–9 cover this family of cases; `test/assets.test.js`
  test 5 and `test/designations.test.js` test "an overlapping span walked backwards
  keeps its id and its direction" pin the span identity half.

### 13.3 TC in the middle of a chain

```
1  Origin  South 1         → (0,−1)
2  A       South 3  TC     → TC at (0,−4)
3  TC      South 3         → (0,−7)
```

- The TC node is at `(0,−4)`, anchored on the base midpoint; the apex points north
  (upstream, towards route 2's cable).
- Route 2's last edge is clipped at the apex; route 3's first edge starts at the base
  midpoint (the node) and runs a full configured spacing to `(0,−5)`.
- No X is drawn at `(0,−4)`.
- Poles of route 2 (`(0,−2)`, `(0,−3)`) are named `A1`, `A2`; poles of route 3
  (`(0,−5)`, `(0,−6)`) are named `TC:1`, `TC:2` — the colon distinguishes a pole
  `TC:1` from the TC point `TC`.
- Exactly the bundled example's shape (routes 3–4); pinned by
  `test/tc_anchor.test.js`, `test/tc_clip.test.js` and `test/designations.test.js`.

### 13.4 An FPB with a marker one span upstream

An FPB box is ~28.5 px wide and ~16 px tall, centred on its node. At the default
40 px spacing, a pole one span away is 40 px away, the box reaches 14.2 px towards it,
and 25.8 px of cable remains — readable. At a 20 px spacing the box would swallow the
neighbour entirely. That is exactly why `requiredSpanLength()` reports 35 px as the
minimum workable spacing; see [clearance](#12-normalized-scene-construction) in
[Rendering and export](07-rendering-and-export.md#7-span-spacing-and-clearance).
`test/clearance.test.js` ("the FPB box really does reach past a neighbour at a tight
spacing") pins the failure mode.
