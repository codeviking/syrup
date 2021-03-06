'use strict';

var cb = require('gulp-cache-breaker');
var autoprefixer = require('gulp-autoprefixer');
var browserify = require('browserify');
var uglify = require('gulp-uglify');
var less = require('gulp-less');
var del = require('del');
var gutil = require('gulp-util');
var gif = require('gulp-if');
var jshint = require('gulp-jshint');
var sourcemaps = require('gulp-sourcemaps');
var source = require('vinyl-source-stream');
var buffer = require('vinyl-buffer');
var stylish = require('jshint-stylish');
var util = require('util');
var path = require('path');
var replace = require('gulp-replace');
var stringify = require('stringify');
var watchify = require('watchify');
var merge = require('../merge');
var plumber = require('gulp-plumber');
var defaultPaths = require('./default-paths');
var runSequence = require('run-sequence');
var babelify = require('babelify');
var react = require('gulp-react');
var express = require('express');
var childProcess = require('child_process');

/**
 * @private
 * Returns the top most directory in the specified path, removing any glob style wildcards (*).
 *
 * @param {string} p The full path
 *
 * @returns {string} The top most directory found.  For instance, returns "asdf" if given
 *                   "/foo/bar/asdf".
 */
function topDirectory(p) {
  return p.split(path.sep).filter(function(part) {
    return part.indexOf('*') === -1;
  }).pop();
}

/**
 * @private
 * Outputs error messages and stops the stream.
 */
function logErrorAndKillStream(error) {
  gutil.log(gutil.colors.red('Error:'), error.toString());
  this.emit('end');
}

/**
 * @private
 * Returns the time difference between start and now nicely formatted for output.
 */
function formattedTimeDiff(start) {
  var diff = Date.now() - start;
  if (diff < 1000) {
    diff = diff + 'ms';
  } else {
    diff = diff / 1000;
    if (diff > 60) {
      diff = diff / 60 + 'm';
    } else {
      diff += 's';
    }
  }
  return gutil.colors.yellow(diff);
}

/**
 * @private
 * Logs a message indicating that the build is complete.
 */
function outputBuildCompleteMessage(start) {
  gutil.log(gutil.colors.green('Build finished successfully in ') + formattedTimeDiff(start));
}

/**
 * @private
 * Helper which converts stdout to gutil.log output
 */
function stdoutToLog(gutil, stdout) {
  var out = stdout.split('\n');
  out.forEach(function(o) {
    var trimmed = o.trim();
    if (trimmed.length > 0) {
      gutil.log(o.trim());
    }
  });
}

module.exports = {
  /**
   * Registers default gulp tasks.
   *
   * @param {object}  gulp                                The gulp library.
   * @param {object}  [options]                           Optional object definining configuration
   *                                                      parameters.
   * @param {boolean} [options.compressJs=true]           If true javascript will be minified.
   *                                                      Defaults to true. This causes the build
   *                                                      to become significantly slower.
   * @param {boolean} [options.sourceMaps=true]           Enables javascript source maps. Defaults
   *                                                      to true.
   * @param {boolean} [options.compressCss=true]          If true styles will be compressed.
   *                                                      Defaults to true.
   * @param {boolean} [options.detectGlobals=true]        Enables browserify global detection and
   *                                                      inclusion.  This is necessary for certain
   *                                                      npm packages to work when bundled for
   *                                                      front-end inclusion.  Defaults to true.
   * @param {boolean} [options.insertGlobals=false]       Enables automatic insertion of node
   *                                                      globals when preparing a javascript
   *                                                      bundler.  Faster alternative to
   *                                                      detectGlobals.  Causes an extra ~1000
   *                                                      lines to be added to the bundled
   *                                                      javascript.  Defaults to false.
   * @param {boolean} [options.disableJsHint=false]       Disables jshint.  Defaults to false.
   * @param {boolean} [options.handleExceptions=false]    If an exception is encountered while
   *                                                      compiling less or bundling javascript,
   *                                                      capture the associated error and output
   *                                                      it cleanly. Defaults to false.
   * @param {string}  [options.jsOut]                     Overrides the default filename for the
   *                                                      resulting javascript bundle.  If not set
   *                                                      the javascript file will be the same name
   *                                                      as the entry point.
   * @param {boolean} [options.disableBabel=false]        Optionally disable babel, the es6 to es6
   *                                                      (and react JSX) transpiler.
   *                                                      See http://babeljs.io for more information.
   * @param {boolean} [options.enableStringify=false]     Optionally enable stringify, a browserify
   *                                                      transform that allows HTML files to be
   *                                                      included via require.
   * @param {number}  [options.port=4000]                 Optional port for the HTTP server started
   *                                                      via the serve task.  Defaults to 4000.
   * @param {object}  [configParameters]                  Optional map of configuration keys. If
   *                                                      set each key is searched for in the built
   *                                                      HTML and replaced with the corresponding
   *                                                      value.
   * @param {object}  [paths]                             Optional object defining paths relevant
   *                                                      to the project. Any specified paths are
   *                                                      merged with the defaults where these paths
   *                                                      take precedence.
   * @param {string}  paths.base                          The base directory of your project where
   *                                                      the gulpfile lives.  Defaults to the
   *                                                      current processes working directory.
   * @param {string}  paths.html                          Path to the project's HTML files.
   * @param {string}  paths.jshint                        Path to the javascript files which should
   *                                                      be linted using jshint.
   * @param {string}  paths.js                            Javascript entry point.
   * @param {string}  paths.allLess                       Path matching all less files which should
   *                                                      be watched for changes.
   * @param {string}  paths.less                          The less entry-point.
   * @param {string}  paths.assets                        Path to the project's static assets.
   * @param {string}  paths.build                         Output directory where the build artifacts
   *                                                      should be placed.
   *
   * @returns {undefined}
   */
  init: function(gulp, options, configParameters, paths) {
    // Produce paths by merging any user specified paths with the defaults.
    paths = merge(defaultPaths, paths);

    if (typeof options !== 'object') {
      options = {};
    }

    if (options.silent === true) {
      gutil.log = gutil.noop;
    }

    if (!gulp || typeof gulp.task !== 'function') {
      throw 'Invalid gulp instance';
    }

    if (!paths || typeof paths !== 'object') {
      throw 'Invalid paths';
    }

    /**
     * @private
     * Helper method which rebundles the javascript and prints out timing information upon completion.
     */
    var rebundleJs = function() {
      gutil.log(gutil.colors.yellow('Rebundling javascript'));
      runOrQueue('html-js');
    };

    var bundlerInstance;
    var watchJs = false;
    /**
     * @private
     * Helper method which provides a (potentially) shared browserify + possible watchify instance
     * for js bundling.
     */
    var bundler = function() {
      if (!bundlerInstance) {
        var b = browserify({
          debug: options.sourceMaps !== false,
          detectGlobals: (options.detectGlobals === undefined ? true : options.detectGlobals),
          insertGlobals: options.insertGlobals,
          cache: {},
          packageCache: {},
          fullPaths: true /* Required for source maps */
        });
        if (watchJs) {
          bundlerInstance = watchify(b, { ignoreWatch: '**/node_modules/**' });
          bundlerInstance.on('update', function(changedFiles) {
            // watchify has a bug where it actually emits changes for files in node_modules, even
            // though by default it's not supposed to.  We protect against that bug by checking if
            // the changes only involve node_modules and if so we don't do anything
            var nodeModuleChanges = changedFiles.filter(function(f) {
              return f.indexOf('/node_modules/') !== -1;
            });
            if (nodeModuleChanges.length !== changedFiles.length) {
              // detect if a package.json file was changed and run an npm install if so as to load
              // the latest dependencies
              var packageJsonChanges = changedFiles.filter(function(f) {
                var fileParts = f.split('.');
                if (fileParts && fileParts.length > 1) {
                  return (
                    path.basename(fileParts[fileParts.length - 2]) === 'package' &&
                    fileParts[fileParts.length - 1] === 'json'
                  );
                } else {
                  return false;
                }
              });
              if (packageJsonChanges.length > 0) {
                // we have to release the bundler since there's no way to fully invalidate
                // cache (other than releasing the bundler itself)
                bundlerInstance.reset();
                bundlerInstance.close();
                bundlerInstance = undefined;
                gutil.log(gutil.colors.yellow('package.json change detected, running npm prune'));
                childProcess.exec('npm prune', function(err, stdout) {
                  if (err) {
                    gutil.log(gutil.colors.red('Error running npm prune:'), err.toString());
                    rebundleJs();
                  } else {
                    if (stdout) {
                      stdoutToLog(gutil, stdout);
                    }
                    gutil.log(gutil.colors.yellow('running npm install'));
                    childProcess.exec('npm install', { cwd: paths.base }, function(err, stdout) {
                      if (err) {
                        gutil.log(gutil.colors.red('Error installing dependencies:'), err.toString());
                        rebundleJs();
                      } else {
                        if (stdout) {
                          stdoutToLog(gutil, stdout);
                        }
                        gutil.log(gutil.colors.yellow('Dependencies installed successfully'));
                        rebundleJs();
                      }
                    });
                  }
                });
              } else {
                gutil.log(gutil.colors.yellow('Javascript changed detected'));
                rebundleJs();
              }
            }
          });
        } else {
          bundlerInstance = b;
        }
        if (options.enableStringify) {
          bundlerInstance.transform(stringify({ extensions: ['.html'], minify: true }));
        }
        if (!options.disableBabel) {
          bundlerInstance.transform(babelify);
        }
        // Browserify can't handle purely relative paths, so resolve the path for them...
        bundlerInstance.add(path.resolve(paths.base, paths.js));
        bundlerInstance.on('error', gutil.log.bind(gutil, 'Browserify Error'));
      }
      return bundlerInstance;
    };

    // Helper method for copying html, see 'html-only' and 'html' tasks.
    var copyHtml = function() {
      gutil.log(
        util.format(
          'Copying html: %s to %s',
          gutil.colors.magenta(paths.html),
          gutil.colors.magenta(paths.build)
        )
      );
      var hasConfig = typeof configParameters === 'object';
      var configKeys = Object.getOwnPropertyNames(configParameters || {});
      var reConfigKeys = new RegExp('(?:' + configKeys.join('|') + ')', 'g');
      var replaceConfigKeys = replace(reConfigKeys, function(key) {
        return configParameters[key] || '';
      });
      return gulp.src(paths.html)
        .pipe(cb(paths.build))
        .pipe(gif(hasConfig, replaceConfigKeys))
        .pipe(gulp.dest(paths.build));
    };

    /**
     * Removes all build artifacts.
     */
    gulp.task('clean', function(cb) {
      gutil.log(util.format('Cleaning: %s', gutil.colors.magenta(paths.build)));
      var targets = [ paths.build ];
      return del(targets, { force: true }, cb);
    });

    /**
     * Compiles less files to css.
     */
    gulp.task('less', function() {
      gutil.log(
        util.format(
          'compiling less to css: %s to %s',
          gutil.colors.magenta(paths.less),
          gutil.colors.magenta(path.relative(process.cwd(), path.resolve(paths.build, paths.less)))
        )
      );
      return gulp.src(paths.less)
        .pipe(gif(options.handleExceptions, plumber(logErrorAndKillStream)))
        .pipe(less({ compress: options.compressCss !== false }))
        .pipe(cb(paths.build))
        .pipe(autoprefixer('last 2 versions'))
        .pipe(gulp.dest(paths.build));
    });

    /**
     * Lints javascript
     */
    gulp.task('jslint', function() {
      if (!options.disableJsHint) {
        gutil.log(util.format('Linting javascript: %s', gutil.colors.magenta(paths.jshint)));
        return gulp.src(paths.jshint)
          .pipe(gif(options.handleExceptions, plumber(logErrorAndKillStream)))
          .pipe(react())
          .pipe(jshint(path.resolve(__dirname, '../.jshintrc')))
          .pipe(jshint.reporter(stylish));
      } else {
        gutil.log(
          gutil.colors.gray(
            'Javascript linting skipped'
          )
        );
      }
    });

    /**
     * Bundles, compresses and produces sourcemaps for javascript.
     */
    gulp.task('js', function() {
      var fn = options.jsOut || path.basename(paths.js).replace(/\.jsx$/, '.js');
      gutil.log(
        util.format(
          'Bundling javascript: %s to %s',
          gutil.colors.magenta(paths.js),
          gutil.colors.magenta(path.relative(process.cwd(), path.resolve(paths.build, fn)))
        )
      );
      return gif(options.handleExceptions, plumber(logErrorAndKillStream))
        .pipe(bundler().bundle())
        .pipe(source(fn))
        .pipe(buffer())
        .pipe(gif(options.sourceMaps !== false, sourcemaps.init({ loadMaps: true })))
        .pipe(gif(options.compressJs !== false, uglify({ compress: { 'drop_debugger': false } })))
        .pipe(gif(options.sourceMaps !== false, sourcemaps.write('./')))
        .pipe(gulp.dest(paths.build));
    });

    /**
     * Copies fonts and icons into the assets directory.
     *
     * This task first copies user-assets, then pipes syrup based assets (currently /fonts
     * and /icons into the asset directory).
     */
    gulp.task('assets', ['user-assets'], function() {
      var assetDir = topDirectory(paths.assets);
      var dest = path.relative(process.cwd(), path.resolve(paths.build, assetDir));
      var iconAndFontBase = path.resolve(__dirname, '..');
      var iconsAndFontPaths = [
        path.resolve(iconAndFontBase, 'fonts', '**', '*'),
        path.resolve(iconAndFontBase, 'icons', '**', '*'),
      ];
      return gulp.src(iconsAndFontPaths, { base: iconAndFontBase })
        .pipe(gulp.dest(dest));
    });

    /**
     * Copies user specific assets.
     */
   gulp.task('user-assets', function() {
      var assetDir = topDirectory(paths.assets);
      var dest = path.relative(process.cwd(), path.resolve(paths.build, assetDir));
      gutil.log(
        util.format(
          'Copying static assets: %s to %s',
          gutil.colors.magenta(paths.assets),
          gutil.colors.magenta(dest)
        )
      );
      return gulp.src(paths.assets)
        .pipe(gulp.dest(dest));
    });

    /**
     * The following html gulp tasks are for use with gulp.watch.  Each is tied to particular
     * dependency.
     */
    gulp.task('html-only', copyHtml);
    gulp.task('html-js', [ 'jslint', 'js' ], copyHtml);
    gulp.task('html-less', [ 'less' ], copyHtml);
    gulp.task('html-assets', [ 'assets' ], copyHtml);

    /**
     * Copies all html files to the build directory.
     */
    gulp.task('html', [ 'js', 'less', 'assets'], copyHtml);

    /**
     * Hash of running tasks. The key is task name; value is a boolean - true if the task should be
     * re-run on completion; false otherwise.
     */
    var runningTasks = {};

    /**
     * Helper function for watch-triggered task calls. This will run the task immediately if there
     * isn't an instance already running, and will queue the task to run after completion if not.
     * @param {string} name the name of the task to run.
     */
    var runOrQueue = function(name) {
      if (runningTasks[name] === undefined) {
        var start = Date.now();
        runningTasks[name] = false;
        gulp.start(name, function() {
          outputBuildCompleteMessage(start);
          var shouldRunAgain = runningTasks[name];
          delete runningTasks[name];
          if (shouldRunAgain) {
            runOrQueue(name);
          }
        });
      } else {
        runningTasks[name] = true;
      }
    };

    /**
     * Watches specific files and rebuilds only the changed component(s).
     */
    gulp.task('watch', function() {
      options.handleExceptions = true;
      watchJs = true;
      bundler();
      gulp.start('build', function() {
        gulp.watch(paths.allLess, function() {
          gutil.log(gutil.colors.yellow('Less change detected'));
          runOrQueue('html-less');
        });
        gulp.watch(paths.assets, function() {
          gutil.log(gutil.colors.yellow('Asset change detected'));
          runOrQueue('html-assets');
        });
        gulp.watch(paths.html, function() {
          gutil.log(gutil.colors.yellow('HTML change detected'));
          runOrQueue('html-only');
        });
      });
    });

    /**
     * Combined build task. This bundles up all required UI resources.
     */
    gulp.task('build', function(cb) {
      var start = Date.now();
      runSequence(
        'clean',
        ['assets', 'jslint', 'js', 'less', 'html'],
        function() {
          cb();
          outputBuildCompleteMessage(start);
        }
      );
    });

    /**
     * Start a simple http serve which serves the contents of paths.build.
     */
    gulp.task('serve', ['build'], function(cb) {
      var server = express();
      var port = options.port || gutil.env.port || 4040;
      server.use(express.static(paths.build));
      server.listen(port, function() {
        gutil.log(
          gutil.colors.yellow('Server listening at ') +
          gutil.colors.cyan('http://localhost:' + port)
        );
        cb();
      });
    });

    /**
     * Alias for watch and serve, start a server with a watcher for dyanmic changes as well.
     */
    gulp.task('wserve', ['watch', 'serve']);
    gulp.task('watch-and-serve', ['wserve']);

    /**
     * Default task. Gets executed when gulp is called without arguments.
     */
    gulp.task('default', ['build']);
  }
};
