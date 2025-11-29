// transformer.ts - Code Transformer using Sucrase

import { transform, type Transform, type Options } from 'sucrase';
import { errMsg, getExtension } from './utils';

const smap = import.meta.use('sourcemap');
const console = import.meta.use('console');

/**
 * Code Transformer
 */
export class CodeTransformer {
    private readonly sourceMapEnabled: boolean = true;

    private readonly transformOptions: Partial<Options> = {
        disableESTransforms: true,
        preserveDynamicImport: true,
        production: false,
    };

    /**
     * Transform code based on file extension
     */
    transform(code: string, filename: string): string {
        const ext = getExtension(filename);

        switch (ext) {
            case '.ts':
                return this.transformTypeScript(code, filename, false);
            case '.tsx':
                return this.transformTypeScript(code, filename, true);
            case '.jsx':
                return this.transformJSX(code, filename);
            case '.json':
                return `export default ${code};`;
            case '.mjs':
            case '.cjs':
            case '.js':
            default:
                return code;
        }
    }

    /**
     * Transform TypeScript code
     */
    private transformTypeScript(code: string, filename: string, jsx: boolean): string {
        try {
            const transforms: Transform[] = ['typescript'];
            if (jsx) {
                transforms.push('jsx');
            }

            const result = transform(code, {
                transforms,
                jsxPragma: 'React.createElement',
                jsxFragmentPragma: 'React.Fragment',
                enableLegacyTypeScriptModuleInterop: false,
                filePath: filename,
                ...this.transformOptions,
            });

            // Load source map
            if (this.sourceMapEnabled && result.sourceMap) {
                try {
                    smap.load(filename, result.sourceMap);
                } catch (error) {
                    console.warn(`Failed to load source map for ${filename}:`, error);
                }
            }

            return result.code;
        } catch (error) {
            throw new Error(`TypeScript transformation failed in ${filename}: ${errMsg(error)}`);
        }
    }

    /**
     * Transform JSX code
     */
    private transformJSX(code: string, filename: string): string {
        try {
            const result = transform(code, {
                transforms: ['jsx'],
                jsxPragma: 'React.createElement',
                jsxFragmentPragma: 'React.Fragment',
                filePath: filename,
                ...this.transformOptions,
            });

            // Load source map
            if (this.sourceMapEnabled && result.sourceMap) {
                try {
                    smap.load(filename, result.sourceMap);
                } catch (error) {
                    console.warn(`Failed to load source map for ${filename}:`, error);
                }
            }

            return result.code;
        } catch (error) {
            throw new Error(`JSX transformation failed in ${filename}: ${errMsg(error)}`);
        }
    }
}