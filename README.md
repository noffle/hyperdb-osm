# hyperdb-osm

> Peer-to-peer OpenStreetMap database over hyperdb.

## Current Status

*Experimental*

Expect plenty of breaking changes -- [semver](https://semver.org/) will be
respected. This isn't currently ready to be relied upon by other modules!

If you're interested in this project, leave an issue and share a bit about what
you're building!

## Usage

```js
var hyperosm = require('hyperdb-osm')
var hyperdb = require('hyperdb')
var ram = require('random-access-memory')
var memdb = require('memdb')
var Geo = require('grid-point-store')

var db = hyperdb(ram, { valueEncoding: 'json' }))
var indexes = memdb()
var geo = Geo(memdb())
var osm = hyperosm({
  db: db,
  index: indexes,
  pointstore: geo
})

var node = {
  type: 'node',
  lat: '-12.7',
  lon: '1.3',
  tags: { feature: 'water fountain' },
  changeset: 'abcdef'
}

osm.create(node, function (err, node) {
  console.log('created node with id', node.id)
  var bbox = [[-13, -11], [1, 2]]
  osm.query(bbox, function (err, elms) {
    console.log(elms)
  })
})
```

outputs

```
created node with id 78d06921416fe95b
[ { type: 'node',
    lat: '-12.7',
    lon: '1.3',
    tags: { feature: 'water fountain' },
    changeset: 'abcdef',
    timestamp: '2017-12-16T00:15:55.238Z',
    id: '78d06921416fe95b',
    version: 'eAXxidJuq9PoqiDsyrLKfR4jME9hgYnGSozS7BKXUqbDH' } ]
```

## API

```js
var hyperosm = require('hyperdb-osm')
```

### var db = hyperosm(opts)

Expected `opts` include:

- `db`: a [hyperdb](https://github.com/mafintosh/hyperdb) instance
- `index`: a [levelup](https://github.com/level/levelup) instance
- `pointstore`: a [grid-point-store](https://github.com/noffle/grid-point-store)
instance

### osm.create(element, cb)

Create the new OSM element `element` and add it to the database. The resulting
element, populated with the `id` and `version` fields, is returned by the
callback `cb`.

### osm.get(id, cb)

Fetch all of the newest OSM elements with the ID `id`. In the case that multiple
peers modified an element prior to sync'ing with each other, there may be
multiple latest elements ("heads") for the ID.

### osm.getByVersion(version, cb)

Fetch a specific OSM element by its version string. Returns `null` if not found,
otherwise the single element.

### osm.put(id, element, cb)

Update an existing element with ID `id` to be the OSM element `element`. The new
element should have all fields that the OSM element would have. The `type` of
the element cannot be changed.

If the value of ID currently returns two or more elements, this new value will
replace them all.

`cb` is called with the new element, including `id` and `version` properties.

### osm.del(id, value, cb)

Marks the element `id` as deleted. A deleted document can be `get` and
`getByVersion`'d like a normal document, and will always have the `{ deleted:
true }` field set.

Deleted ways, nodes, and relations are all still returned by the `query` API.
The nodes of a deleted are not included in the results.

### osm.batch(ops, cb)

Create and update many elements atomically. `ops` is an array of objects
describing the elements to be added or updated.

```js
{
  type: 'put|del',
  id: 'id',
  value: { /* element */ }
}
```

If no `id` field is set, the element is created, otherwise it is updated with
the element `value`.

An operation type of `'put'` inserts a new element or modifies an existing one,
while a type of`'del'` will mark the element as deleted.

Currently, doing a batch insert skips many validation checks in order to be as
fast as possible.

*TODO: accept `opts.validate` or `opts.strict`*

### var rs = osm.query(bbox[, cb])

Retrieves all `node`s, `way`s, and `relation`s touching the bounding box `bbox`.

`bbox` is expected to be of the format `[[minLat, maxLat], [minLon, maxLon]]`.
Latitude runs between `(-85, 85)`, and longitude between `(-180, 180)`.

A callback parameter `cb` is optional. If given, it will be called as
`cb(err, elements)`. If not provided or set to `null`, a Readable stream will be
returned that can be read from as elements are emitted. The distinction between
the two is that the callback will buffer all results before they are returned,
but the stream will emit results as they arrive, resulting in much less
buffering. This can make a large impact on memory use for queries on large
datasets.

The following [algorithm](https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_.2Fapi.2F0.6.2Fmap) is used to determine what OSM elements are returned:

1. All nodes that are inside a given bounding box and any relations that
   reference them.
2. All ways that reference at least one node that is inside a given bounding
   box, any relations that reference them (the ways), and any nodes outside the
   bounding box that the ways may reference.
3. All relations that reference one of the nodes, ways or relations included due
   to the above rules. (This does not apply recursively; meaning that elements
   referenced by a relation are not returned by virtue of being in that
   relation.)

### var rs = osm.getChanges(id[, cb])

Fetch a list of all OSM elements belonging to the changeset `id`.

A callback parameter `cb` is optional. If given, it will be called as `cb(err,
results)`. If not provided or set to `null`, a Readable stream will be returned
that can be read from as results are ready.

Objects of the following form are returned:

```js
{
  id: '...',
  version: '...'
}
```

### var rs = osm.getReferrers(id[, cb])

Fetch a list of all OSM ways and relations that refer to the element with ID
`id`. For a node, this can be ways or relations. For a way or relation, this can
only be relations.

A callback parameter `cb` is optional. If given, it will be called as `cb(err,
results)`. If not provided or set to `null`, a Readable stream will be returned
that can be read from as results are ready.

Objects of the following form are returned:

```js
{
  id: '...',
  version: '...'
}
```

### osm.getPreviousHeads(version, cb)

Get all immediately previous versions of the element at `version`.

In the simple case of one writer writing an element and then updating it,

```
A_1  <--  A_2
```

`getPreviousHeads(A_2)` would return `[A_2]`.

In a more complex case of two writers that both forked `C_1` and then one wrote
a new head to merge them,

```
        /-- C_2 <--\
C_1 <---            --- C4
        \-- C_3 <--/
```

`getPreviousHeads(C_4)` would return `[C_2, C_3]`.

## Architecture

*TODO: talk about forking data & forking architecture*

## Combining with other hyperdb modules

If you had other modules that store data in a hyperdb, say `hyperdb-media` and
`hyperdb-maptiles`, you could combine these and this module together with a very
minimal amount of glue to create a simpler database interface for consumers:

```js
var hyperdb = Hyperdb(...)
var osm = hyperosm(...)
var media = hypermedia(...)
var maptiles = hypertiles(...)

var db = {
  osm: osm,
  users: users,
  media: media,
  tiles: maptiles,
  replicate: hyperdb.replicate.bind(hyperdb)
}
```

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install hyperdb-osm
```

## License

ISC

