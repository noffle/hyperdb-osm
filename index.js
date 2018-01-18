module.exports = Osm

var async = require('async')
var through = require('through2')
var readonly = require('read-only-stream')
var bs58 = require('bs58')
var sub = require('subleveldown')
var collect = require('collect-stream')
var utils = require('./lib/utils')

var checkElement = require('./lib/check-element')
var validateBoundingBox = require('./lib/utils').validateBoundingBox
var createChangesetsIndex = require('./lib/changesets-index')
var createGeoIndex = require('./lib/geo-index')
var createRefsIndex = require('./lib/refs-index')

module.exports = {
  gives: 'osm',
  needs: ['hyperdb', 'leveldb', 'pointstore'],
  create: function (api) {
    return new Osm(api)
  }
}

function Osm (api) {
  if (!(this instanceof Osm)) return new Osm(api)
  if (!api) throw new Error('missing param "api"')

  this.db = api.hyperdb
  this.index = api.leveldb
  this.geo = api.pointstore
  this.dbPrefix = '/osm'

  // Create indexes
  this.changesets = createChangesetsIndex(this.db, this.index)
  this.refs = createRefsIndex(this.db, this.index)
  this.geo = createGeoIndex(this.db, sub(this.index, 'geo'), this.geo)
}

// OsmElement -> Error
Osm.prototype.create = function (element, cb) {
  var self = this

  // Element format verification
  var errs = checkElement(element)
  if (errs.length) return cb(errs[0])

  utils.populateElementDefaults(element)

  // Generate unique ID for element
  var id = utils.generateId()

  // Write the element to the db
  var key = this.dbPrefix + '/elements/' + id
  console.log('creating', key, '->', element)
  this.db.put(key, element, function (err) {
    if (err) return cb(err)
    var w = self.db._localWriter
    w.head(function (err, node) {
      if (err) return cb(err)

      // TODO(noffle): need hyperdb to return the 'node' that was created
      var elm = Object.assign({}, element)
      elm.id = id
      elm.version = utils.versionFromKeySeq(w.key, node.seq)
      cb(null, elm)
    })
  })
}

// OsmId -> [OsmElement]
Osm.prototype.get = function (id, cb) {
  var self = this

  var key = this.dbPrefix + '/elements/' + id
  this.db.get(key, function (err, res) {
    if (err) return cb(err)
    res = res || []

    cb(null, res.map(function (node) {
      var v = node.value
      v.id = id
      v.version = utils.nodeToVersion(self.db, node)
      return v
    }))
  })
}

// OsmVersion -> OsmElement
Osm.prototype.getByVersion = function (osmVersion, cb) {
  utils.versionToNode(this.db, osmVersion, function (err, node) {
    if (err) return cb(err)
    var elm = Object.assign({
      id: utils.hyperDbKeyToId(node.key),
      version: osmVersion
    }, node.value)
    cb(null, elm)
  })
}

// OsmId, OsmElement -> OsmElement
Osm.prototype.put = function (id, element, cb) {
  var self = this

  this.get(id, function (err, elms) {
    if (err) return cb(err)

    // Ensure element already exists
    if (elms.length === 0) {
      return cb(new Error('element with id ' + id + ' doesnt exist'))
    }

    // Ensure existing type matches new type
    var type = elms[0].type
    if (type !== element.type) {
      return cb(new Error('existing element is type ' + type +
        ' but new element is type ' + element.type))
    }

    // Check for type errors
    var errs = checkElement(element)
    if (errs.length) return cb(errs[0])

    // Write to hyperdb
    var key = self.dbPrefix + '/elements/' + id
    console.log('updating', key, '->', element)
    self.db.put(key, element, function (err) {
      if (err) return cb(err)

      // TODO(noffle): need hyperdb to return the 'node' that was created
      var w = self.db._localWriter
      w.head(function (err, node) {
        if (err) return cb(err)
        var elm = Object.assign({}, element)
        elm.id = id
        elm.version = utils.versionFromKeySeq(w.key, node.seq)
        cb(null, elm)
      })
    })
  })
}

Osm.prototype.batch = function (ops, cb) {
  var self = this
  var batch = ops.map(function (op) {
    var prefix = self.dbPrefix + '/elements/'
    if (!op.id) op.id = prefix + utils.generateId()
    else op.id = prefix + op.id
    return {
      type: 'put',
      key: op.id,
      value: op.value
    }
  })
  this.db.batch(batch, cb)
}

// TODO: return a stream if no cb is given
// Id -> { id, version }
Osm.prototype.getChanges = function (id, cb) {
  var self = this
  this.changesets.ready(function () {
    self.changesets.getElements(id, cb)
  })
}

// BoundingBox -> (Stream or Callback)
Osm.prototype.query = function (bbox, cb) {
  var seen = {}

  var err = validateBoundingBox(bbox)
  if (err) {
    if (cb) {
      return cb(err)
    } else {
      var t = through.obj()
      process.nextTick(function () { t.emit('error', err) })
      return t
    }
  }

  // Convert p2p-db-osm bbox format to grid-point-store format
  // TODO(noffle): unify the bbox formats!
  bbox = [[bbox[0][0], bbox[1][0]], [bbox[1][1], bbox[1][1]]]

  var self = this
  var t = through.obj(onPoint)
  this.geo.ready(function () {
    self.refs.ready(function () {
      self.geo.queryStream(bbox).pipe(t)
    })
  })

  if (!cb) {
    return readonly(t)
  } else {
    collect(t, {encoding: 'object'}, cb)
  }

  function add (elm) {
    if (!seen[elm.version]) {
      seen[elm.version] = true
      t.push(elm)
    }
  }

  function onPoint (version, _, next) {
    console.log('onPoint', version)
    self.getByVersion(version, function (err, elm) {
      if (err) return next(err)
      add(elm)

      getWaysAndRelationReferrers(elm, function (err, elms) {
        if (err) return next(err)
        elms.forEach(add)
        next()
      })
    })
  }

  function getRelationReferrers (elm, cb) {
    getRefererElements(elm, function (err, elms) {
      if (err) return cb(err)

      async.reduce(elms, [], reducer, cb)

      function reducer (accum, elm, cb) {
        if (elm.type === 'relation') {
          accum.push(elm)
        }
        cb(null, accum)
      }
    })
  }

  // Get all head versions of all ways and relations referring to an element,
  // *plus* all relations referring to those elements.
  function getWaysAndRelationReferrers (elm, cb) {
    getRefererElements(elm, function (err, elms) {
      if (err) return cb(err)

      async.reduce(elms, [], reducer, cb)

      function reducer (accum, elm, cb) {
        accum.push(elm)
        getRelationReferrers(elm, function (err, res) {
          if (err) return cb(err)

          accum.push.apply(accum, res)

          if (elm.type === 'way') {
            getWayRefElements(elm, function (err, res) {
              if (err) return cb(err)
              accum.push.apply(accum, res)
              cb(null, accum)
            })
          } else {
            cb(null, accum)
          }
        })
      }
    })
  }

  // Get all head versions of all ways and relations referring to an element.
  function getRefererElements (elm, cb) {
    self.refs.getReferersById(elm.id, function (err, refs) {
      if (err) return cb(err)

      var refIds = refs.map(function (ref) { return ref.id })
      async.reduce(refIds, [], reducer, cb)

      function reducer (accum, id, cb) {
        self.get(id, function (err, elms) {
          if (err) return cb(err)
          accum.push.apply(accum, elms)
          cb(null, accum)
        })
      }
    })
  }

  // Get all head versions of the nodes in a way.
  function getWayRefElements (elm, cb) {
    async.reduce(elm.refs, [], reducer, cb)

    function reducer (accum, id, cb) {
      self.get(id, function (err, elms) {
        if (err) return cb(err)
        accum.push.apply(accum, elms)
        cb(null, accum)
      })
    }
  }
}

