var path    = require('path'),
fs      = require('fs'),
async   = require('async'),
glob    = require('glob'),
crypto  = require('crypto'),
parser  = require('uglify-js').parser,
uglify  = require('uglify-js').uglify,
zlib    = require('zlib'),

BACKSLASH_N = "BACKSLASHN";

/**
 * Take a variable number of object arguments and extend a base object with each of the properties in those
 * objects starting from left to right.
 */
exports.extend = function extend() {
  var merged = {};
  
  for(var i=0; i<arguments.length; ++i) {
    var obj = arguments[i] || {};
    for(var key in obj) {
      merged[key] = obj[key];
    }
  }
  return merged;
};

/**
 * CSS files can be include by passing a string that is the path to the css file OR an object which contains a key that 
 * is the media type of the css file and the value is the path to the css file.  This function takes the css 'route' and 
 * returns an object with a media type and a path.
 */
exports.extractMediaMeta = function extractMediaMeta(route){
  var meta = {
        mediaType: 'screen',
        path: route
      };

  if(typeof route !== 'string') {
    for(var key in route) {
      meta.mediaType = key;
      meta.path = route[key];
    }
  }
  
  return meta;
};

/**
 * Given a dir path, this function will synchronously create the folders if they don't exist.
 */
function mkdirRecursiveSync(dir, mode){
  if(fs.existsSync(dir)) {
    return true;
  }
  
  var pathParts = path.normalize(dir).split('/');
  mkdirRecursiveSync(pathParts.slice(0,-1).join('/'), mode);
  try {
    fs.mkdirSync(dir, mode);
  } catch (e) {
    console.err("Unable to create folder '" + dir + "': " + e)
    return false;
  }
  return true;
}
exports.mkdirRecursiveSync = mkdirRecursiveSync;

/**
 * Given a list of 'allFiles' and a list of 'assemblyFolders', this function will filter
 * out any files in 'allFiles' that are in one of the 'assemblyFolders' folders.
 */
exports.filterAssembliesFiles = function filterAssembliesFiles(allFiles, assemblyFolders) {
  var folders = assemblyFolders.map(function(folder) {
        return folder + (folder.substr(folder.length-1) != '/' ? '/' : '');
      }),
      files = allFiles.filter(function removeAssemblyFiles(file){
      for(var i=0; i<folders.length; ++i) {
        if(file.indexOf(folders[i]) === 0) {
          return false;
        }
      };
    
    return true;
  });
  
  assemblyFolders = assemblyFolders.map(function(file){
    return file + ".js";
  });
  return files.concat(assemblyFolders);
};

//Scan the module folders for the presence of css files that need to be precompiled
exports.findModuleCSSFiles = function(moduleFolders) {
  var cssFiles = [];
  
  for(var i=0; i<moduleFolders.length; ++i) {
    var name = path.basename(moduleFolders[i]),
        fileName = path.join(moduleFolders[i], name + ".css");
    
    if(fs.existsSync(fileName)){
      fileName = moduleFolders[i] + ".css";
      cssFiles.push(fileName.replace(/js/, 'css'));
    }
  }
  
  return cssFiles;
};

/**
 * Given a list of paths that may contain globs, resolve the globs and set the `paths` to be an array
 * of all the actual paths that `origPaths` expands to
 */
exports.expandPaths = function expandPaths(origPaths, scanDir, cb){
  //Take a path that contains a potential glob in it and resolve it to the list of files corresponding to that glob
  var expandPath = function expandPath(aPath, cb){
    if(aPath.indexOf("*") === -1) {
      cb(null, [aPath]);
    } else {
      glob(aPath, {
        mark: true, 
        strict: true
      }, function globCB(er, files){
        //strip out any non-folder matches
        files = files.filter(function(file){
          return (file[file.length-1] === '/');
        });
        files = files.map(function(file){
          return file.substr(0, file.length - 1);
        });
        cb(null, files);
      });
    }
  };
  
  detectFoldersWithManifest(scanDir, function(manifestPaths) {
    origPaths = origPaths.concat(manifestPaths);
    
    async.map(origPaths, expandPath, function expandPathsComplete(er, results){
      var paths = [];

      for(var i=0; i<results.length; ++i) {
        var result = results[i];
        paths = paths.concat(result);
      }

      paths = paths.filter(function(aPath) {
        return aPath.length > 0 && fs.existsSync(aPath);
      });

      cb(paths);
    });
  });
};

function detectFoldersWithManifest(scanDir, cb) {
  var checkPath = scanDir ? scanDir + "/**/asset-manifest.json" : false;
  
  if(scanDir) {
    glob(checkPath, {
      mark: true, 
      strict: true
    }, function globCB(er, files){
      if(!files || files.length === 0) {
        return cb([]);
      }
      
      var finalFolders = files.map(function(file) {
        var manifestFile = fs.readFileSync(file, 'utf8'),
            manifest = null;
        
        try {
          if(file.indexOf("asset-manager") !== -1) {
            return ''
          }
          manifest = JSON.parse(manifestFile);
          if(manifest.assetPath) {
            return path.join(path.dirname(file), manifest.assetPath);
          } else {
            console.warn("Missing assetPath property in the manifest file: " + file);
          }
        } catch(e) {
          console.error("Unable to parse manifest file '" + file + "':" + e.message);
        }
        return '';
      });
      cb(finalFolders);;
    });
  } else {
    cb([]);
  }
}

exports.writeToFile = function writeToFile(filePath, contents, doGzip, cb) {
  async.waterfall([
    function(callback){
      if(doGzip) {
        exports.gzipString(contents, function(err, buffer){
          if(err){
            console.error("Failed to gzip file '" + filePath + "': " + err);
            callback(err, '');
          } else {
            callback(null, buffer);
          }
        });
      } else {
        callback(null, contents);
      }
    },
    
    function(buffer, callback){
      filePath = path.resolve(filePath);
      mkdirRecursiveSync(path.dirname(filePath), 0755);
      fs.writeFile(filePath, buffer, callback);
    }
  ], function(err){
    cb(err);
  });
};

/**
 * Return the hash for the provided contents.
 */
exports.generateHash = function generateHash(content){
  var hash = crypto.createHash('md5');
  //Simulate writing file to disk, including encoding coersions
  //This ensures that the md5 in the name matches the command-line tool.
  hash.update(new Buffer(content));
  return hash.digest('hex');
};

/**
 * Minify a javascript string.
 */
exports.compressJS = function compressJS(content){
  var ast = parser.parse(content);
  ast = uglify.ast_mangle(ast);
  ast = uglify.ast_squeeze(ast);
  return uglify.gen_code(ast);
};

/**
 * gzip a string.
 */
exports.gzipString = function gzipString(contents, cb){
  zlib.gzip(contents, function(err, buffer) {
    if (err) {
      cb(err);
    } else {
      cb(null, buffer);
    }
  });
};

/**
 * Read all of the translation files in baseLocalePath with baseName and put them in an object to return
 */
exports.readLocaleFiles = function readLocaleFiles(baseLocalePath, baseName){
  var files = fs.readdirSync(baseLocalePath),
      re = baseName + "_(.*).json",
      langs = {};
  
  if(!files || files.length === 0) {
    return null;
  }
  
  files = files.forEach(function(file) {
    var toks = file.match(re),
        fileContents,
        lang,
        data;
    
    if(toks) {
      lang = toks[1];
      fileContents = fs.readFileSync(path.join(baseLocalePath, file)).toString('utf8');
      
      try {
        data = JSON.parse(fileContents);
        langs[lang] = data;
      } catch(e) {
        console.error("Unable to parse locale file: " + path.join(baseLocalePath, file) + ":: " + e);
      }
    }
  });
  
  return langs;
};

/**
 * Convert a string of html into a string that can be embeded in a javascript file.
 */
exports.convertHTMLtoJS = function convertHTMLtoJS(html, hasLangResources){
  var sb = "";
  
  //Create the variable for our lang
  sb += "\nvar snippetsRaw = ";
  sb += flattenString(extractBody(html));
  sb += ";\n";

  sb += "\n\nfunction getSnippets(){\nvar snip = document.createElement('div');";
  if (hasLangResources) {
    sb += "\n$(snip).html(snippetsRaw.format(lang));\n";
  } else {
    sb += "\n$(snip).html(snippetsRaw);\n";
  }
  sb += "\nreturn snip;\n}\n";

  return sb;
};

/**
 * Escape any characters that need to be and format string so that it can be used as the value of a javascript assignment operator.
 * @param html
 * @return The passed in html safely formated so that it can be used in a javascript assignment operator.
 */
function flattenString(html) {
  var escapedQuotes = html.replace(/"/g, "\\\""),
  lines = escapedQuotes.split(BACKSLASH_N),
  sb = '',
  inExcludeBlock = false;
      
  for(var i=0; i<lines.length; ++i){
    var line = lines[i];
    if(line.indexOf("<!-- exclude START -->") !== -1) { //start block
      inExcludeBlock = true;
    }

    if(!inExcludeBlock && line.indexOf("<!-- exclude LINE -->") === -1) {//strip out lines that are only there to allow the preview to look correct
      sb += "\"" + line + "\\n\" + \n";
    }

    if(line.indexOf("<!-- exclude END -->") !== -1) { //end block
      inExcludeBlock = false;
    }
  }
  sb += "\"\"";

  return sb;
}

/**
 * Remove line breaks but preserve their position so we can reintroduce them in a safe way later.
 * @param html
 * @return
 */
function removeLineBreaks(html) {
  html = html.replace(/\r/g, "");//remove all of the \r chars
  html = html.replace(/\n/g, BACKSLASH_N);//preserve the positioning of the \n chars
  return html;
}

/**
 * Pull out the contents of the body tag
 * @param html
 * @return The contents of the body tag.
 */
function extractBody(html) {
  var htmlOneLine = removeLineBreaks(html),
  body = htmlOneLine.replace(/(.*)<body[^>]*>(.*)<\/body>(.*)/gi, "$2").trim();
  return body;
}