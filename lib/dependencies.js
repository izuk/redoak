// Calculate dependency trees and watch them.
//
// Dependency trees are hierarchical representations of HTML/JS/CSS files.
// Each node looks like: [fileObj, children]. fileObj contains the type of the
// file, the filename, and other data after reading and sometimes parsing the
// file. children are the potential HTML/JS/CSS dependencies of the fileObj.
//
// watch lets you watch the filesystem for any changes to the tree.

var _ = require('underscore');
var events = require('events');
var fs = require('fs');
var html5 = require('html5');
var jsdom = require('jsdom');
var jsp = require('uglify-js').parser;
var mustache = require('./public/mustache');
var path = require('path');
var queryselector = require('./queryselector');
var watcher = require('./watcher');

// Used for watching trees.
var emitter = new events.EventEmitter();

// jsdom options.
var defaultFeatures = {
  // Used for easier scraping.
  QuerySelector: true,

  // No need to fetch anything.
  FetchExternalResources: [],

  // domjs doesn't implement document.write correctly.
  ProcessExternalResources: []
};

/** Parse HTML into a document structure. */
function parseHTML(data) {
  // Some boilerplate to parse the DOM.
  var options = { features: defaultFeatures, parser: html5 };
  var window = jsdom.jsdom(null, null, options).createWindow();
  var document = window.document;
  var parser = new html5.Parser({ document: document });
  parser.parse(data);
  return document;
}

// Every tree has these dependencies.
var basicDependencies =
    ['widget.mjs', 'public/rapid.js', 'public/basewidget.js', 'public/mustache.js']
    .map(function(x) {
  return {
    type: path.extname(x).substr(1),
    name: path.basename(x),
    filename: __dirname + '/' + x
  };
});

/**
 * Returns array of objects that represent the use elements.  Removes the use
 * elements from the DOM at the same time.
 */
function eatUses(parent) {
  var uses = parent.querySelectorAll('use');
  var result = _.map(uses, function(use) {
    var mixins = use.getAttribute('mixins').split(' ');
    var obj = use.textContent || '{}';
    var result = _.extend({ mixins: mixins, obj: obj },
                          queryselector.objectify(use, parent));
    use.parentNode.removeChild(use);
    return result;
  });
  result.reverse();
  return result;
}

// Handlers the different directives we may come across.
var fileHandlers = {
  'mjs': function(fileObj, data) {
    fileObj.data = data;
    return [];
  },

  'js': function(fileObj, data) {
    var ast = jsp.parse(data);

    // AST looks like ['toplevel', [ -- statements -- ]].
    // Only look through toplevel for directives.
    var fileObjs = [];
    var types = { require: 'js' };
    ast[1].forEach(function(stmt) {
      if (stmt[0]  == 'directive') {
        var match = stmt[1].match(/^(.*)? (.*)/);
        if (match && types[match[1]]) {
          var name = match[2];
          fileObjs.push({ type: types[match[1]], name: name });
        }
      }
    });

    fileObj.data = data;
    return fileObjs;
  },

  'resource': function(fileObj, data) {
    fileObj.data = data;
    return [];
  },

  'oak': function(fileObj, data) {
    var document = parseHTML(data);

    // Gather up templates.
    fileObj.templates = [];

    _(document.querySelectorAll('template')).forEach(function(template) {
      template.parentNode.removeChild(template);
      var name = template.getAttribute('name');
      if (!name) {
        throw new Error('template but no name');
      }

      // Find all template dependencies.
      var links = template.querySelectorAll(
          'link[rel=stylesheet][href], link[rel=js][href]');
      var dependencies = _(links).map(function(link) {
        link.parentNode.removeChild(link);
        return {
          name: link.getAttribute('href'),
          type: link.getAttribute('rel') == 'js' ? 'js' : 'resource',
          filename: path.resolve(path.dirname(fileObj.filename),
                                 link.getAttribute('href'))
        };
      });

      var all = template.querySelectorAll('template *');

      // Find all events.
      var events = [];
      for (var j = 0; j < all.length; j++) {
        var attrs = Array.prototype.slice.call(all[j].attributes)
            .filter(function(x) { return x.name.substr(0, 6) === 'oak-on' });

        if (attrs.length) {
          var qs = queryselector.to(all[j], template);
          for (var k = 0; k < attrs.length; k++) {
            events.push([qs, attrs[k].name.substr(6), attrs[k].value]);
            all[j].removeAttribute(attrs[k].name);
          }
        }
      }

      // Find all the unbound variables.

      // unbound will be an array of tuples.
      //   the first item contains unbound data for child nodes.
      //   the second item contains unbound data for attributes.
      //   the third item contains lookup data for all the elements.
      var unboundFilter = function(x) { return x.match(/{{|{#|{\^/); };
      var unbound = _(all).map(function(el, i) {
        if (el.tagName == 'USE') {
          return;
        }
        var name = 'a' + i;
        var childMap = function(x, i) {
          if (x.nodeType != x.TEXT_NODE || !unboundFilter(x.value)) {
            return undefined;
          }
          return { ename: name, childi: i, value: x.value };
        };
        var attrMap = function(x) {
          if (!unboundFilter(x.value)) {
            return undefined;
          }
          return { ename: name, aname: x.name, value: x.value };
        };
        var transform = function(things, map) {
          return _.chain(things).map(map).compact().flatten().value();
        };

        var children = transform(el.childNodes, childMap);
        var attrs = transform(el.attributes, attrMap);
        attrs.forEach(function(x) { el.removeAttribute(x.aname); });
        var qs = queryselector.to(el, template);
        if (attrs.length || children.length) {
          return [children, attrs, _.extend({ name: name }, qs)];
        } else {
          return undefined;
        }
      });
      unbound = _.compact(unbound);

      // Unzip unbound, which will be part of our template data.
      unbound = {
        children: _(_(unbound).pluck('0')).flatten(),
        attrs: _(_(unbound).pluck('1')).flatten(),
        elements: _(unbound).pluck('2')
      };

      var uses = eatUses(template);

      fileObj.templates.push({
        events: events,
        name: name,
        data: template.innerHTML.replace(/^\s+|\s+$/, ''),
        dependencies: dependencies,
        unbound: unbound,
        uses: uses
      });
    });

    // Gather up remaining scripts and CSS not in templates.
    var includes = document.querySelectorAll(
        'script[src], link[rel=stylesheet][href], link[rel=oak][href]');
    var fileObjs = _(includes).map(function(include) {
      var attr = include.tagName == 'LINK' ? 'href' : 'src';
      var src = include.getAttribute(attr);
      if (src.charAt(0) == '/') {
        // We don't handle absolute paths right now.
        return;
      }
      var type;
      if (include.tagName == 'SCRIPT') {
        type = 'js';
      } else if (include.getAttribute('rel') == 'stylesheet') {
        type = 'resource';
      } else {
        type = 'oak';
      }
      if (type == 'js' || type == 'oak') {
        include.parentNode.removeChild(include);
      }
      return { name: src , type: type,
               filename: path.resolve(path.dirname(fileObj.filename), src) };
    });

    fileObj.document = document;
    fileObj.uses = eatUses(document);
    var uniqMap = function(f) { return f.filename; };
    return _.compact(_.uniq(_.flatten(
        [basicDependencies, fileObjs,
        _(fileObj.templates).pluck('dependencies')]), uniqMap));
  }
};

/**
 * Constructs dependency tree for given file object.
 *
 * The tree consists of JS, resources, and errors. JS files are currently the
 * only type that can specify other dependencies. We read the JS files, parse
 * them, and then apply the same procedure to its dependencies.
 *
 * @param fileObj { name: 'some_filename', type: 'js|oak|resource' }
 *                Can specify 'filename' for where it lives on filesystem.
 * @param callback callback(tree)
 *                 Tree is an array where the first object is the file object.
 *                 If 'resource' type, node has 'data' with file contents.
 *                 If an error occurred, node has 'error' property.
 *                 Second element is an array with the dependencies.
 */
function dependencies(fileObj, callback) {
  (function recurse(fileObj, cycles, callback) {
    fileObj = _.extend({}, fileObj);
    if (!fileHandlers[fileObj.type]) {
      fileObj.error = 'Do not know how to handle this type.';
      return callback([fileObj, []]);
    }
    if (!fileObj.filename)  {
      fileObj.filename = path.resolve(fileObj.name);
    }
    if (cycles[fileObj.filename]) {
      fileObj.error = 'Cyclic dependency.';
      return callback([fileObj, []]);
    }
    cycles = Object.create(cycles);
    cycles[fileObj.name] = true;

    fs.readFile(fileObj.filename, 'utf-8', function(err, data) {
      if (err) {
        fileObj.error = 'Could not open file.';
        callback([fileObj, []]);
        return;
      }

      var fileObjs = [];
//      try {
        fileObjs = fileHandlers[fileObj.type](fileObj, data);
//      } catch(e) {
//        fileObj.error = e;
//      }

      if (fileObjs.length) {
        var total = fileObjs.length;
        var childResults = new Array(fileObjs.length);
        fileObjs.forEach(function(childFileObj, i) {
          if (!childFileObj.filename) {
            childFileObj.filename = path.resolve(
                path.dirname(fileObj.filename), childFileObj.name);
          }
          recurse(childFileObj, cycles, function(t) {
            childResults[i] = t;
            if (--total == 0) {
              callback([fileObj, childResults]);
            }
          });
        });
      } else {
        callback([fileObj, []]);
      }
    });
  })(fileObj, {}, callback);
}

/** Call a function for each node in a tree. */
function forEachNode(tree, callback) {
  if (tree.length) {
    callback(tree);
    for (var i = 0; i < tree[1].length; i++) {
      forEachNode(tree[1][i], callback);
    }
  }
}

/** Used by watch and unwatch to stop internal callbacks from running. */
function unwatchTreeHelper(oldTree, callback) {
  forEachNode(oldTree, function(node) {
    var internalCallbacks = watcher.listeners(node[0].filename);
    for (var i = 0; i < internalCallbacks.length; i++) {
      if (internalCallbacks[i].external == callback) {
        watcher.unwatch(node[0].filename, internalCallbacks[i]);
        if (!emitter.listeners(oldTree[0].filename).length) {
          // No one is listening for this tree anymore. It can be deleted.
          delete treesForRoots[oldTree[0].filename];
        }
        return;
      }
    }
  });
}

/** Map from root tree filenames to their latest trees.  */
var treesForRoots = {};

/** Watches for changes for a fileObj and its dependencies. */
function watch(rootFileObj, callback) {
  var name = path.resolve(rootFileObj.name);
  emitter.on(name, callback);
  (function dep(oldTree, fileObj) {
    dependencies(rootFileObj, function(tree) {
      unwatchTreeHelper(oldTree, callback);

      if (emitter.listeners(name).indexOf(callback) == -1) {
        // Tree was unwatched while we were calculating dependencies.
        return;
      }

      // It's OK to override other tree entries, though it's extra work. The
      // important thing is that treesForRoots contains the latest dependency
      // information so that we can unwatch all watched files.
      treesForRoots[name] = tree;

      forEachNode(tree, function(node) {
        var internalCallback = dep.bind(this, tree, node[0]);
        internalCallback.external = callback;
        watcher.watch(node[0].filename, internalCallback);
        if (node.error) {
          modules.exports.emit('error', tree, fileObj);
        }
      });
      emitter.emit(name, tree, fileObj);
    });
  })([], rootFileObj);
}

/** Stops watching fileObj. */
function unwatch(fileObj, callback) {
  var name = path.resolve(fileObj.name);
  emitter.removeListener(name, callback);
  if (treesForRoots[name]) {
    // If treeForRoots is defined, then watch dependencies callback has already
    // occurred. Otherwise, we trust watch to notice the listener is gone.
    unwatchTreeHelper(treesForRoots[name], callback);
  }
}

module.exports = new events.EventEmitter();
module.exports.parseHTML = parseHTML;
Object.defineProperty(module.exports, '__fs',
                      { set: function(x) { fs = x; } });
module.exports.dependencies = dependencies;
module.exports.forEachNode = forEachNode;
module.exports.watch = watch;
module.exports.unwatch = unwatch;
