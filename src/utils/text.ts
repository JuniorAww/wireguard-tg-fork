const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1000;
const TB = GB * 1000;

export function getUsageText(bytes: number) {
    const usage = bytes || 0;
    
    if (usage > TB) return (usage / TB).toFixed(1) + ' ТБ';
    if (usage > GB) return (usage / GB).toFixed(1) + ' ГБ';
    if (usage > MB) return (usage / MB).toFixed(1) + ' МБ';
    return                 (usage / KB).toFixed(1) + ' КБ';
    // мяу мяу? МЯУ?
}

const latinMap: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'j', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    ' ': '_',
}

export function escapeConfigName(input: string): string {
    if (!input?.length) return "_";
    
    let result = "";
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const lcase = char.toLowerCase();
        
        if (latinMap[char]) result += latinMap[char]
        else if (char === char.toUpperCase() && latinMap[lcase]) {
            const mapped = latinMap[lcase];
            if (i < input.length - 1 && input[i + 1].toUpperCase() === input[i + 1]) {
                result += mapped.toUpperCase();
            }
            else result += mapped[0].toUpperCase() + mapped.slice(1)
        }
        else result += char; // latin fix
    }
    
    if (/^\d/.test(result[0])) result = '_' + result;
    
    return result.replace(/[^a-z0-9_.]/gi, '');
}
