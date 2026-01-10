const console = import.meta.use('console');

/**
 * 十六进制调试输出函数
 * @param prefix 输出前缀（如模块名）
 * @param data 要输出的数据（Buffer、Uint8Array 或 number[]）
 * @param options 配置选项
 */
export function hexDump(
    prefix: string,
    data: Uint8Array | number[] | ArrayBuffer,
    options: {
        width?: number;        // 每行字节数，默认16
        showAscii?: boolean;   // 是否显示ASCII字符，默认true
        showOffset?: boolean;  // 是否显示偏移量，默认true
        dualColumn?: boolean;  // 是否双列显示，默认true（双列对应格式）
        colorize?: boolean;    // 是否彩色输出，默认false
    } = {}
): void {
    const {
        width = 16,
        showAscii = true,
        showOffset = true,
        dualColumn = true,
        colorize = false
    } = options;

    // 确保数据是 Uint8Array
    let bytes = new Uint8Array(data);

    const len = bytes.length;
    const actualWidth = dualColumn ? Math.max(8, width) : width;

    // ANSI 颜色代码
    const colors = {
        reset: '\x1b[0m',
        prefix: '\x1b[36m',    // 青色
        offset: '\x1b[33m',    // 黄色
        hex: '\x1b[32m',       // 绿色
        ascii: '\x1b[37m',     // 白色
        nonPrintable: '\x1b[90m', // 灰色
        highlight: '\x1b[1m'   // 高亮
    };

    const color = (type: keyof typeof colors, text: string): string => {
        return colorize ? `${colors[type]}${text}${colors.reset}` : text;
    };

    let count = 0;
    loop: for (let i = 0; i < len; i += actualWidth) {
        let line = '';

        // 添加前缀
        if (prefix) {
            line += color('prefix', `${prefix}: `);
        }

        // 添加偏移量
        if (showOffset) {
            line += color('offset', i.toString(16).padStart(8, '0') + '  ');
        }

        // 双列格式：第一列十六进制
        const hexParts: string[] = [];
        const asciiParts: string[] = [];

        for (let j = 0; j < actualWidth; j++) {
            count ++;
            if (count == 256) {
                console.log('...');
                break loop;
            }

            if (i + j < len) {
                const byte = bytes[i + j]!;
                // 十六进制部分
                hexParts.push(color('hex', byte.toString(16).padStart(2, '0')));
                // ASCII 部分
                if (showAscii) {
                    asciiParts.push(
                        byte >= 32 && byte <= 126 ?
                            color('ascii', String.fromCharCode(byte)) :
                            color('nonPrintable', '.')
                    );
                }
            } else {
                hexParts.push('  ');
                if (showAscii) asciiParts.push(' ');
            }

            // 在中间添加分隔（双列格式的关键）
            if (dualColumn && j === Math.floor(actualWidth / 2) - 1 && j < actualWidth - 1) {
                hexParts.push(' ');
                if (showAscii) asciiParts.push(' ');
            }
        }

        // 构建输出行
        line += color('hex', hexParts.join(' '));

        // 添加 ASCII 显示区域
        if (showAscii) {
            line += '  ' + color('ascii', '|' + asciiParts.join('') + '|');
        }

        console.log(line);
    }
}