import { intro, outro, select, text } from '@clack/prompts'
import { Mutex } from 'async-mutex'
import { execSync, spawnSync } from 'child_process'
import chokidar from 'chokidar'
import { randomUUID } from 'crypto'
import esbuild from 'esbuild'
import { sassPlugin } from 'esbuild-sass-plugin'
import fs, { promises } from 'fs'
import { rm } from 'fs/promises'
import { globby } from 'globby'
import http from 'http'
import path from 'path'
import prettyBytes from 'pretty-bytes'
import serveHandler from 'serve-handler'
import { styleText } from 'util'
import { WebSocketServer } from 'ws'
import { CreateArgv } from './args.js'
import {
  cacheFile,
  cwd,
  fp,
  ORIGIN_NAME,
  QUARTZ_SOURCE_BRANCH,
  UPSTREAM_NAME,
  version,
} from './constants.js'
import {
  escapePath,
  exitIfCancel,
  gitPull,
  popContentFolder,
  stashContentFolder,
} from './helpers.js'

/**
 * Resolve content directory path
 * @param contentPath path to resolve
 */
function resolveContentPath(contentPath) {
  if (path.isAbsolute(contentPath)) return path.relative(cwd, contentPath)
  return path.join(cwd, contentPath)
}

/**
 * Handles `npx quartz create`
 * @param {*} argv arguments for `create`
 */
export async function handleCreate(argv) {
  console.log()
  intro(styleText(['bgGreen', 'black'], ` Rockery v${version} `))
  const contentFolder = resolveContentPath(argv.directory)
  let setupStrategy = argv.strategy?.toLowerCase()
  let linkResolutionStrategy = argv.links?.toLowerCase()
  const sourceDirectory = argv.source

  // If all cmd arguments were provided, check if they're valid
  if (setupStrategy && linkResolutionStrategy) {
    // If setup isn't, "new", source argument is required
    if (setupStrategy !== 'new') {
      // Error handling
      if (!sourceDirectory) {
        outro(
          styleText(
            'red',
            `Setup strategies (arg '${styleText(
              'yellow',
              `-${CreateArgv.strategy.alias[0]}`,
            )}') other than '${styleText(
              'yellow',
              'new',
            )}' require content folder argument ('${styleText(
              'yellow',
              `-${CreateArgv.source.alias[0]}`,
            )}') to be set`,
          ),
        )
        process.exit(1)
      } else {
        if (!fs.existsSync(sourceDirectory)) {
          outro(
            styleText(
              'red',
              `Input directory to copy/symlink 'content' from not found ('${styleText(
                'yellow',
                sourceDirectory,
              )}', invalid argument "${styleText('yellow', `-${CreateArgv.source.alias[0]}`)})`,
            ),
          )
          process.exit(1)
        } else if (!fs.lstatSync(sourceDirectory).isDirectory()) {
          outro(
            styleText(
              'red',
              `Source directory to copy/symlink 'content' from is not a directory (found file at '${styleText(
                'yellow',
                sourceDirectory,
              )}', invalid argument ${styleText('yellow', `-${CreateArgv.source.alias[0]}`)}")`,
            ),
          )
          process.exit(1)
        }
      }
    }
  }

  // Use cli process if cmd args werent provided
  if (!setupStrategy) {
    setupStrategy = exitIfCancel(
      await select({
        message: `Choose how to initialize the content in \`${contentFolder}\``,
        options: [
          { value: 'new', label: 'Empty Quartz' },
          { value: 'copy', label: 'Copy an existing folder', hint: 'overwrites `content`' },
          {
            value: 'symlink',
            label: 'Symlink an existing folder',
            hint: "don't select this unless you know what you are doing!",
          },
        ],
      }),
    )
  }

  async function rmContentFolder() {
    const contentStat = await fs.promises.lstat(contentFolder)
    if (contentStat.isSymbolicLink()) {
      await fs.promises.unlink(contentFolder)
    } else {
      await rm(contentFolder, { recursive: true, force: true })
    }
  }

  const gitkeepPath = path.join(contentFolder, '.gitkeep')
  if (fs.existsSync(gitkeepPath)) {
    await fs.promises.unlink(gitkeepPath)
  }
  if (setupStrategy === 'copy' || setupStrategy === 'symlink') {
    let originalFolder = sourceDirectory

    // If input directory was not passed, use cli
    if (!sourceDirectory) {
      originalFolder = escapePath(
        exitIfCancel(
          await text({
            message: 'Enter the full path to existing content folder',
            placeholder:
              'On most terminal emulators, you can drag and drop a folder into the window and it will paste the full path',
            validate(fp) {
              const fullPath = escapePath(fp)
              if (!fs.existsSync(fullPath)) {
                return "The given path doesn't exist"
              } else if (!fs.lstatSync(fullPath).isDirectory()) {
                return 'The given path is not a folder'
              }
            },
          }),
        ),
      )
    }

    await rmContentFolder()
    if (setupStrategy === 'copy') {
      await fs.promises.cp(originalFolder, contentFolder, {
        recursive: true,
        preserveTimestamps: true,
      })
    } else if (setupStrategy === 'symlink') {
      await fs.promises.symlink(originalFolder, contentFolder, 'dir')
    }
  } else if (setupStrategy === 'new') {
    await fs.promises.writeFile(
      path.join(contentFolder, 'index.md'),
      `---
title: Welcome to Quartz
---

This is a blank Quartz installation.
See the [documentation](https://quartz.jzhao.xyz) for how to get started.
`,
    )
  }

  // Use cli process if cmd args werent provided
  if (!linkResolutionStrategy) {
    // get a preferred link resolution strategy
    linkResolutionStrategy = exitIfCancel(
      await select({
        message: `Choose how Quartz should resolve links in your content. This should match Obsidian's link format. You can change this later in \`quartz.config.ts\`.`,
        options: [
          {
            value: 'shortest',
            label: 'Treat links as shortest path',
            hint: '(default)',
          },
          {
            value: 'absolute',
            label: 'Treat links as absolute path',
          },
          {
            value: 'relative',
            label: 'Treat links as relative paths',
          },
        ],
      }),
    )
  }

  // now, do config changes
  const configFilePath = path.join(cwd, 'quartz.config.ts')
  let configContent = await fs.promises.readFile(configFilePath, { encoding: 'utf-8' })
  configContent = configContent.replace(
    /markdownLinkResolution: '(.+)'/,
    `markdownLinkResolution: '${linkResolutionStrategy}'`,
  )
  await fs.promises.writeFile(configFilePath, configContent)

  // setup remote
  execSync(
    `git remote show upstream || git remote add upstream https://github.com/jackyzha0/quartz.git`,
    { stdio: 'ignore' },
  )

  outro(`You're all set! Not sure what to do next? Try:
  • Customizing Quartz a bit more by editing \`quartz.config.ts\`
  • Running \`npx quartz build --serve\` to preview your Quartz locally
  • Hosting your Quartz online (see: https://quartz.jzhao.xyz/hosting)
`)
}

/**
 * Handles `npx quartz build`
 * @param {*} argv arguments for `build`
 */
export async function handleBuild(argv) {
  if (argv.serve) {
    argv.watch = true
  }

  console.log(`\n${styleText(['bgGreen', 'black'], ` Rockery v${version} `)} \n`)
  const ctx = await esbuild.context({
    entryPoints: [fp],
    outfile: cacheFile,
    bundle: true,
    keepNames: true,
    minifyWhitespace: true,
    minifySyntax: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    packages: 'external',
    metafile: true,
    sourcemap: true,
    sourcesContent: false,
    plugins: [
      sassPlugin({
        type: 'css-text',
        cssImports: true,
      }),
      sassPlugin({
        filter: /\.inline\.scss$/,
        type: 'css',
        cssImports: true,
      }),
      {
        name: 'inline-script-loader',
        setup(build) {
          build.onLoad({ filter: /\.inline\.(ts|js)$/ }, async (args) => {
            let text = await promises.readFile(args.path, 'utf8')

            // remove default exports that we manually inserted
            text = text.replace('export default', '')
            text = text.replace('export', '')

            const sourcefile = path.relative(path.resolve('.'), args.path)
            const resolveDir = path.dirname(sourcefile)
            const transpiled = await esbuild.build({
              stdin: {
                contents: text,
                loader: 'ts',
                resolveDir,
                sourcefile,
              },
              write: false,
              bundle: true,
              minify: true,
              platform: 'browser',
              format: 'esm',
            })
            const rawMod = transpiled.outputFiles[0].text
            return {
              contents: rawMod,
              loader: 'text',
            }
          })
        },
      },
    ],
  })

  const buildMutex = new Mutex()
  let lastBuildMs = 0
  let cleanupBuild = null
  const build = async (clientRefresh) => {
    const buildStart = new Date().getTime()
    lastBuildMs = buildStart
    const release = await buildMutex.acquire()
    if (lastBuildMs > buildStart) {
      release()
      return
    }

    if (cleanupBuild) {
      console.log(styleText('yellow', 'Detected a source code change, doing a hard rebuild...'))
      await cleanupBuild()
    }

    const result = await ctx.rebuild().catch((err) => {
      console.error(`${styleText('red', "Couldn't parse Quartz configuration:")} ${fp}`)
      console.log(`Reason: ${styleText('grey', err)}`)
      process.exit(1)
    })
    release()

    if (argv.bundleInfo) {
      const outputFileName = 'quartz/.quartz-cache/transpiled-build.mjs'
      const meta = result.metafile.outputs[outputFileName]
      console.log(
        `Successfully transpiled ${Object.keys(meta.inputs).length} files (${prettyBytes(
          meta.bytes,
        )})`,
      )
      console.log(await esbuild.analyzeMetafile(result.metafile, { color: true }))
    }

    // bypass module cache
    // https://github.com/nodejs/modules/issues/307
    const { default: buildQuartz } = await import(`../../${cacheFile}?update=${randomUUID()}`)
    // ^ this import is relative, so base "cacheFile" path can't be used

    cleanupBuild = await buildQuartz(argv, buildMutex, clientRefresh)
    clientRefresh()
  }

  let clientRefresh = () => {}
  if (argv.serve) {
    const connections = []
    clientRefresh = () => connections.forEach((conn) => conn.send('rebuild'))

    if (argv.baseDir !== '' && !argv.baseDir.startsWith('/')) {
      argv.baseDir = '/' + argv.baseDir
    }

    await build(clientRefresh)
    const server = http.createServer(async (req, res) => {
      if (argv.baseDir && !req.url?.startsWith(argv.baseDir)) {
        console.log(
          styleText(
            'red',
            `[404] ${req.url} (warning: link outside of site, this is likely a Quartz bug)`,
          ),
        )
        res.writeHead(404)
        res.end()
        return
      }

      // strip baseDir prefix
      req.url = req.url?.slice(argv.baseDir.length)

      const serve = async () => {
        const release = await buildMutex.acquire()
        await serveHandler(req, res, {
          public: argv.output,
          directoryListing: false,
          headers: [
            {
              source: '**/*.*',
              headers: [{ key: 'Content-Disposition', value: 'inline' }],
            },
            {
              source: '**/*.webp',
              headers: [{ key: 'Content-Type', value: 'image/webp' }],
            },
            // fixes bug where avif images are displayed as text instead of images (future proof)
            {
              source: '**/*.avif',
              headers: [{ key: 'Content-Type', value: 'image/avif' }],
            },
          ],
        })
        const status = res.statusCode
        const statusString =
          status >= 200 && status < 300
            ? styleText('green', `[${status}]`)
            : styleText('red', `[${status}]`)
        console.log(statusString + styleText('grey', ` ${argv.baseDir}${req.url}`))
        release()
      }

      const redirect = (newFp) => {
        newFp = argv.baseDir + newFp
        res.writeHead(302, {
          Location: newFp,
        })
        console.log(
          styleText('yellow', '[302]') +
            styleText('grey', ` ${argv.baseDir}${req.url} -> ${newFp}`),
        )
        res.end()
      }

      const fp = req.url?.split('?')[0] ?? '/'

      // handle redirects
      if (fp.endsWith('/')) {
        // /trailing/
        // does /trailing/index.html exist? if so, serve it
        const indexFp = path.posix.join(fp, 'index.html')
        if (fs.existsSync(path.posix.join(argv.output, indexFp))) {
          req.url = fp
          return serve()
        }

        // does /trailing.html exist? if so, redirect to /trailing
        let base = fp.slice(0, -1)
        if (path.extname(base) === '') {
          base += '.html'
        }
        if (fs.existsSync(path.posix.join(argv.output, base))) {
          return redirect(fp.slice(0, -1))
        }
      } else {
        // /regular
        // does /regular.html exist? if so, serve it
        let base = fp
        if (path.extname(base) === '') {
          base += '.html'
        }
        if (fs.existsSync(path.posix.join(argv.output, base))) {
          req.url = fp
          return serve()
        }

        // does /regular/index.html exist? if so, redirect to /regular/
        const indexFp = path.posix.join(fp, 'index.html')
        if (fs.existsSync(path.posix.join(argv.output, indexFp))) {
          return redirect(fp + '/')
        }
      }

      return serve()
    })

    server.listen(argv.port)
    const wss = new WebSocketServer({ port: argv.wsPort })
    wss.on('connection', (ws) => connections.push(ws))
    console.log(
      styleText(
        'cyan',
        `Started a Quartz server listening at http://localhost:${argv.port}${argv.baseDir}`,
      ),
    )
  } else {
    await build(clientRefresh)
    ctx.dispose()
  }

  if (argv.watch) {
    const paths = await globby([
      '**/*.ts',
      'quartz/cli/*.js',
      'quartz/static/**/*',
      '**/*.tsx',
      '**/*.scss',
      'package.json',
    ])
    chokidar
      .watch(paths, { ignoreInitial: true })
      .on('add', () => build(clientRefresh))
      .on('change', () => build(clientRefresh))
      .on('unlink', () => build(clientRefresh))

    console.log(styleText('grey', 'hint: exit with ctrl+c'))
  }
}

/**
 * Handles `npx quartz update`
 * @param {*} argv arguments for `update`
 */
export async function handleUpdate(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  console.log(`\n${styleText(['bgGreen', 'black'], ` Rockery v${version} `)} \n`)
  console.log('Backing up your content')
  execSync(
    `git remote show upstream || git remote add upstream https://github.com/jackyzha0/quartz.git`,
  )
  await stashContentFolder(contentFolder)
  console.log(
    "Pulling updates... you may need to resolve some `git` conflicts if you've made changes to components or plugins.",
  )

  try {
    gitPull(UPSTREAM_NAME, QUARTZ_SOURCE_BRANCH)
  } catch {
    console.log(styleText('red', 'An error occurred above while pulling updates.'))
    await popContentFolder(contentFolder)
    return
  }

  await popContentFolder(contentFolder)
  console.log('Ensuring dependencies are up to date')

  /*
  On Windows, if the command `npm` is really `npm.cmd', this call fails
  as it will be unable to find `npm`. This is often the case on systems
  where `npm` is installed via a package manager.

  This means `npx quartz update` will not actually update dependencies
  on Windows, without a manual `npm i` from the caller.

  However, by spawning a shell, we are able to call `npm.cmd`.
  See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
  */

  const opts = { stdio: 'inherit' }
  if (process.platform === 'win32') {
    opts.shell = true
  }

  const res = spawnSync('npm', ['i'], opts)
  if (res.status === 0) {
    console.log(styleText('green', 'Done!'))
  } else {
    console.log(styleText('red', 'An error occurred above while installing dependencies.'))
  }
}

/**
 * Handles `npx quartz restore`
 * @param {*} argv arguments for `restore`
 */
export async function handleRestore(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  await popContentFolder(contentFolder)
}

/**
 * Handles `npx quartz sync`
 * @param {*} argv arguments for `sync`
 */
export async function handleSync(argv) {
  const contentFolder = resolveContentPath(argv.directory)
  console.log(`\n${styleText(['bgGreen', 'black'], ` Rockery v${version} `)}\n`)
  console.log('Backing up your content')

  if (argv.commit) {
    const contentStat = await fs.promises.lstat(contentFolder)
    if (contentStat.isSymbolicLink()) {
      const linkTarg = await fs.promises.readlink(contentFolder)
      console.log(styleText('yellow', 'Detected symlink, trying to dereference before committing'))

      // stash symlink file
      await stashContentFolder(contentFolder)

      // follow symlink and copy content
      await fs.promises.cp(linkTarg, contentFolder, {
        recursive: true,
        preserveTimestamps: true,
      })
    }

    const currentTimestamp = new Date().toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    const commitMessage = argv.message ?? `Quartz sync: ${currentTimestamp}`
    spawnSync('git', ['add', '.'], { stdio: 'inherit' })
    spawnSync('git', ['commit', '-m', commitMessage], { stdio: 'inherit' })

    if (contentStat.isSymbolicLink()) {
      // put symlink back
      await popContentFolder(contentFolder)
    }
  }

  await stashContentFolder(contentFolder)

  if (argv.pull) {
    console.log(
      "Pulling updates from your repository. You may need to resolve some `git` conflicts if you've made changes to components or plugins.",
    )
    try {
      gitPull(ORIGIN_NAME, QUARTZ_SOURCE_BRANCH)
    } catch {
      console.log(styleText('red', 'An error occurred above while pulling updates.'))
      await popContentFolder(contentFolder)
      return
    }
  }

  await popContentFolder(contentFolder)
  if (argv.push) {
    console.log('Pushing your changes')
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
    const res = spawnSync('git', ['push', '-uf', ORIGIN_NAME, currentBranch], {
      stdio: 'inherit',
    })
    if (res.status !== 0) {
      console.log(
        styleText('red', `An error occurred above while pushing to remote ${ORIGIN_NAME}.`),
      )
      return
    }
  }

  console.log(styleText('green', 'Done!'))
}
