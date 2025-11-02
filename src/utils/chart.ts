import { join } from 'path';
import { CategoryScale, Chart, LinearScale, BarController, BarElement, Legend } from 'chart.js';
import { Canvas, GlobalFonts } from '@napi-rs/canvas';
import { HourlyUsage } from '$/api/connections';
import { DailyUsage, UserSettings } from '$/db/types';
import { getUsage, getUsageText } from '$/utils/text';

Chart.register([
	CategoryScale,
	BarController,
	BarElement,
	LinearScale,
	Legend,
]);

GlobalFonts.registerFromPath("./fonts/Inter_18pt-Medium.ttf", "Inter Regular");
GlobalFonts.registerFromPath("./fonts/Inter_18pt-Bold.ttf", "Inter Bold");

async function getChart(config: any, width: number, height: number): Promise<Buffer> {
    const canvas = new Canvas(width, height);
    const chart = new Chart(canvas as any, config);
    
    // TODO fix
    // @ts-ignore
	const buffer = await canvas.toBuffer('image/png', { matte: 'white', compressionLevel: 0 });
	chart.destroy();
	
    return buffer;
}

export async function generateUsageChart(hourlyUsageHistory: HourlyUsage[], settings: UserSettings): Promise<Buffer> {
    const labels = hourlyUsageHistory.map(h => {
        const date = new Date();
        date.setHours(h.hour, 0, 0, 0);
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    });
    
    const largest = Math.max(
		...hourlyUsageHistory.map(a => a.tx),
		...hourlyUsageHistory.map(a => a.rx),
    )
    
    const [ x, size ] = getUsageText(largest).split(' ');
    console.log(x)
    hourlyUsageHistory.sort((a,b) => a.hour - b.hour);
    const txData = hourlyUsageHistory.map(h => getUsage(h.tx, size));
    const rxData = hourlyUsageHistory.map(h => getUsage(h.rx, size));
	const suggestedMax = +(+x + +x / 10).toFixed(1); // UPD: поднять верхнюю границу на 10%
    
    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `Загружено (${size})`,
                    backgroundColor: 'rgba(255, 99, 132, 0.5)',
                    borderColor: 'rgb(255, 99, 132)',
                    borderWidth: 3,
                    data: rxData,
					borderSkipped: true,
                },
                {
                    label: `Скачано (${size})`,
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    borderWidth: 3,
                    data: txData,
					borderSkipped: true,
                },
            ],
        },
        options: {
			indexAxis: 'x',
			scales: {
			  x: {
				beginAtZero: true,
				...basicTicks
			  },
			  y: {
				ticks: {
					suggestedMax,
					font: { family: 'Inter Regular', size: 12 }, color: '#888'
				}
			  }
			},
			plugins: {
			  legend: {
				labels: basicTicks.ticks
			  }
			},
			...ratioParams
		}
    };
    
    return await getChart(chartConfig, 800, 400);
}

export async function generateMonthlyUsageChart(dailyUsage: DailyUsage[] = []): Promise<Buffer> {
    const labels: string[] = [];
    const txData: number[] = [];
    const rxData: number[] = [];

    const today = new Date();
    
    const largest = Math.max(
		dailyUsage.sort((a,b) => b.tx - a.tx)?.[0]?.tx || 0,
        dailyUsage.sort((a,b) => b.tx - a.tx)?.[0]?.rx || 0
    )
    
    const [ _, size ] = getUsageText(largest).split(' ');
    
    for (let i = 29; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateString = date.toISOString().split('T')[0];
        const day = date.getDate().toString().padStart(2, '0');

        labels.push(day);

        const usageForDay = dailyUsage.find(d => d.date === dateString);

        txData.push(usageForDay ? getUsage(usageForDay.tx, size) : 0);
        rxData.push(usageForDay ? getUsage(usageForDay.rx, size) : 0);
    }
    
    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `Скачано (${size})`,
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    borderWidth: 3,
                    data: txData,
					borderSkipped: true,
                },
                {
                    label: `Отправлено (${size})`,
                    backgroundColor: 'rgba(255, 99, 132, 0.5)',
                    borderColor: 'rgb(255, 99, 132)',
                    borderWidth: 3,
                    data: rxData,
					borderSkipped: true,
                },
            ],
        },
        options: {
			indexAxis: 'x',
			scales: {
			  x: {
				beginAtZero: true,
				title: {
				  display: true,
				  text: 'Трафик (GB)',
				  font: { family: 'Roboto Bold', size: 16 },
				  color: '#666'
				},
				...basicTicks
			  },
			  y: {
				...basicTicks
			  }
			},
			plugins: {
			  legend: {
				labels: basicTicks.ticks
			  }
			},
			...ratioParams
		}
    };

    return await getChart(chartConfig, 800, 400);
}

export async function generateTopUsersChart(userUsage: { name: string, usage: number }[]): Promise<Buffer> {
    const topUsers = userUsage.slice(0, 10);

    const labels = topUsers.map(u => u.name);
    const largest = topUsers.sort((a,b) => b.usage - a.usage)?.[0]?.usage || 0;
    const [ _, size ] = getUsageText(largest).split(' ');
    const data = topUsers.map(u => getUsage(u.usage, size));
	
	const chartConfig = {
		type: 'bar',
		data: {
			labels: labels,
			datasets: [
				{
					backgroundColor: 'rgba(75, 192, 192, 0.5)',
					borderColor: 'rgb(75, 192, 192)',
                    borderWidth: 2,
					data: data,
				},
			],
		},
		options: {
			indexAxis: 'y',
			scales: {
				x: {
					beginAtZero: true,
					title: {
						display: true,
						text: `Всего использовано (${size})`,
						...titleFont,
					},
					...basicTicks,
				},
				y: {
					...basicTicks,
				}
			},
			plugins: {
				legend: {
					display: false
				}
			},
			...ratioParams
		}
	};


    return await getChart(chartConfig, 900, 450);
}

const basicTicks = {
	ticks: { font: { family: 'Inter Regular', size: 12 }, color: '#888' }
}

const titleFont = {
	font: { family: 'Inter Regular', size: 14 }, color: '#888'
}

const ratioParams = {
	devicePixelRatio: 2,
	responsive: false,
	maintainAspectRatio: false,
}
