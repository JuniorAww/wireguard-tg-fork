import fs from 'node:fs';

const timezones: CityData[] = loadTimezones();

export interface CityData {
    name: string;
    lc: string;
    utc: number;
}

function loadTimezones() {
    const result: CityData[] = [];
    const data = JSON.parse(fs.readFileSync('./config/cities.json', 'utf-8'));
    for (const city in data) {
        result.push({
            name: city,
            lc: city.toLowerCase().replace(/-/g,' '),
            utc: data[city],
        })
    }
    return result;
}

export function findCity(city: string): CityData | undefined {
    const lowercased = city.toLowerCase().replace(/-/g,' ');
    return timezones.find(x => x.lc === lowercased);
}
