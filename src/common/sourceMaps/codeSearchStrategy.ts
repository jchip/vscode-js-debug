/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import type * as vscodeType from 'vscode';
import { PathMapping } from '../../configuration';
import { FileGlobList } from '../fileGlobList';
import { ILogger, LogTag } from '../logging';
import { forceForwardSlashes } from '../pathUtils';
import { NodeSearchStrategy } from './nodeSearchStrategy';
import { ISourceMapMetadata } from './sourceMap';
import { createMetadataForFile, ISearchStrategy } from './sourceMapRepository';

/**
 * A source map repository that uses VS Code's proposed search API to
 * look for candidate files.
 */
@injectable()
export class CodeSearchStrategy implements ISearchStrategy {
  private readonly nodeStrategy = new NodeSearchStrategy(this.logger);

  constructor(private readonly vscode: typeof vscodeType, private readonly logger: ILogger) {}

  public static createOrFallback(logger: ILogger) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const code: typeof import('vscode') = require('vscode');
      if (code.workspace.findTextInFiles !== undefined) {
        return new CodeSearchStrategy(code, logger);
      }
    } catch {
      // ignored -- VS won't have vscode as a viable import, fall back to the memory/node.js version
    }

    return new NodeSearchStrategy(logger);
  }

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    // see https://github.com/microsoft/vscode/issues/101889
    return this.nodeStrategy.streamAllChildren(files, onChild);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithPathMaps<T>(
    pathMapping: PathMapping,
    onChild: (child: Required<ISourceMapMetadata>) => Promise<T>,
    pattern = '**',
  ): Promise<T[]> {
    const todo: Promise<T>[] = [];

    // process pathMapping config
    const mappedPaths = Object.keys(pathMapping);
    for (const path of mappedPaths) {
      const files = await this.vscode.workspace.findFiles(
        new this.vscode.RelativePattern(path, pattern),
      );
      for (const file of files) {
        const sourceMapUrl = file.path.replace(path, pathMapping[path]);
        todo.push(
          onChild({
            compiledPath: file.path,
            mtime: -1,
            sourceMapUrl,
          }),
        );
      }
    }

    return (await Promise.all(todo)).filter((t): t is T => t !== undefined);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T>(
    outFiles: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    await this.vscode.workspace.findTextInFiles(
      { pattern: 'sourceMappingURL', isCaseSensitive: true },
      {
        ...this.getTextSearchOptions(outFiles),
        previewOptions: { charsPerLine: Number.MAX_SAFE_INTEGER, matchLines: 1 },
      },
      result => {
        const text = 'text' in result ? result.text : result.preview.text;
        todo.push(
          createMetadataForFile(result.uri.fsPath, text)
            .then(parsed => parsed && onChild(parsed))
            .catch(error =>
              this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
                error,
                file: result.uri.fsPath,
              }),
            ),
        );
      },
    );

    this.logger.info(LogTag.SourceMapParsing, `findTextInFiles search found ${todo.length} files`);

    return (await Promise.all(todo)).filter((t): t is T => t !== undefined);
  }

  private getTextSearchOptions(files: FileGlobList): vscodeType.FindTextInFilesOptions {
    return {
      include: new this.vscode.RelativePattern(
        files.rootPath,
        forceForwardSlashes(files.patterns.filter(p => !p.startsWith('!')).join(', ')),
      ),
      exclude: files.patterns
        .filter(p => p.startsWith('!'))
        .map(p => forceForwardSlashes(p.slice(1)))
        .join(','),
      useDefaultExcludes: false,
      useIgnoreFiles: false,
      useGlobalIgnoreFiles: false,
      followSymlinks: true,
      beforeContext: 0,
      afterContext: 0,
    };
  }
}
