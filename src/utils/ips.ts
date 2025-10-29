const INT_MAX = 2 ** 32;

export async function sourceEval(source) {
	const asyncEval = new Function(`return (async () => { return ${source} })();`);
	return await asyncEval();
}

export function getAllowedIPs(allow, block) {
	let allowedIPs = allow.map(c => cidrToRange(c))
	let blockedIPs = block.map(c => cidrToRange(c))
	
	const allowedRanges = getRanges(allowedIPs)
	const blockedRanges = getRanges(blockedIPs)
	
	const result = calculate(allowedRanges, blockedRanges)
	
	const cleaned = result.reduce((acc, [start, end]) => {
		const s = Math.max(0, start);
		const e = Math.min(INT_MAX - 1, end);
		if (s <= e) acc.push([s, e]);
		return acc;
	}, []);
	
	const cidrs = [];
	
	for (const [ s, e ] of cleaned) {
		for (const cidr of outputRange(s, e)) {
			cidrs.push(cidr);
		}
	}

	return cidrs;
}

function getRanges(array) {
    if (array.length === 0) return [];
	
    array.sort((a, b) => a[0] - b[0]);
    
    const result = [ array[0] ];
    
    for (let i = 1; i < array.length; i++) {
        const last = result[result.length - 1];
        if (last[1] + 1 >= array[i][0]) {
            last[1] = Math.max(last[1], array[i][1]);
        } else {
            result.push(array[i]);
        }
    }
    
    return result;
}

function calculate(allowedRange, disallowedRange) {
    let result = [...allowedRange];
    
    for (const disallowed of disallowedRange) {
        const newResult = [];
        
        for (const allowed of result) {
            if (allowed[1] < disallowed[0] || allowed[0] > disallowed[1]) {
                newResult.push(allowed);
            } else {
                if (allowed[0] < disallowed[0]) {
                    newResult.push([allowed[0], disallowed[0] - 1]);
                }
                
                if (allowed[1] > disallowed[1]) {
                    newResult.push([disallowed[1] + 1, allowed[1]]);
                }
            }
        }
        
        result = newResult;
    }
    
    return result;
}

function outputRange(start, end) {
	const result = [];
    let current = Number(start);
	
    while (current <= end) {
        let alignPow = 1;
		
        if (current === 0) {
            alignPow = INT_MAX;
        } else {
            while (alignPow * 2 <= INT_MAX && current % (alignPow * 2) === 0) {
                alignPow *= 2;
            }
        }
		
        const prefAlign = 32 - Math.floor(Math.log2(alignPow));
        const remaining = end - current + 1;
        const prefRange = 32 - Math.floor(Math.log2(remaining));
        let prefix = Math.max(prefAlign, prefRange);
		
        if (prefix < 0) prefix = 0;
        if (prefix > 32) prefix = 32;
		
        const blockSize = Math.pow(2, 32 - prefix);
		
        result.push(`${int2Ip(current >>> 0)}/${prefix}`);
		
        if (blockSize <= 0 || !isFinite(blockSize)) break;
        current += blockSize;
    }
	
	return result;
}

function cidrToRange(cidr) {
    const parts = cidr.trim().split('/');
    const [ip, maskStr] = parts;
    
    const mask = parseInt(maskStr, 10);
    const ipInt = ip2Int(ip.trim());
    
    const blockSize = mask === 0 ? INT_MAX : Math.pow(2, 32 - mask);
    const start = Math.floor(ipInt / blockSize) * blockSize;
    const end = (start + blockSize - 1) >>> 0;
    
    return [start >>> 0, end >>> 0];
}

const sorted = array => {
    for (let x = 0; x < array.length - 1; x++) {
        for (let y = 0; y < array.length - x - 1; y++) {
            const a = array[y].split("/")[0];
            const b = array[y+1].split("/")[0];
            
            const aInt = ip2Int(a);
            const bInt = ip2Int(b);
            
            if (aInt > bInt)
                [array[y], array[y + 1]] = [array[y + 1], array[y]];
        }
    }
    
    return array;
}

const ip2Int = ip => {
    const parts = ip.trim().split(".");
    
    return parts.reduce((a, b) => {
        return a * 256 + parseInt(b, 10);
    }, 0) >>> 0;
}

const S256 = 256 * 256;
const SS256 = S256 * 256;

const int2Ip = num => {
    return [
        Math.floor(num / SS256) % 256,
        Math.floor(num / S256) % 256,
        Math.floor(num / 256) % 256,
				   num % 256,
    ].join('.');
}
