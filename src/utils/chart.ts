import ChartJsImage from 'chart.js-image';
import { HourlyUsage } from '$/api/connections';
import { DailyUsage } from '$/db/types';

export async function generateUsageChart(hourlyUsageHistory: HourlyUsage[]): Promise<Buffer> {
    const labels = hourlyUsageHistory.map(h => {
        const date = new Date();
        date.setHours(h.hour, 0, 0, 0);
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    });
    const txData = hourlyUsageHistory.map(h => h.tx / (1024 * 1024)); // в МБ
    const rxData = hourlyUsageHistory.map(h => h.rx / (1024 * 1024)); // в МБ

    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Загружено (MB)',
                    backgroundColor: 'rgba(255, 99, 132, 0.5)',
                    borderColor: 'rgb(255, 99, 132)',
                    data: rxData,
                },
                {
                    label: 'Скачано (MB)',
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    data: txData,
                },
            ],
        },
    };

    const chart = new ChartJsImage()
        // @ts-ignore
        .chart(chartConfig)
        // @ts-ignore
        .width(800)
        // @ts-ignore
        .height(400)
        .backgroundColor('white');
    return await chart.toBuffer();
}

export async function generateMonthlyUsageChart(dailyUsage: DailyUsage[] = []): Promise<Buffer> {
    const labels: string[] = [];
    const txData: number[] = [];
    const rxData: number[] = [];

    const today = new Date();
    for (let i = 29; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateString = date.toISOString().split('T')[0];
        const day = date.getDate().toString().padStart(2, '0');

        labels.push(day);

        const usageForDay = dailyUsage.find(d => d.date === dateString);

        txData.push(usageForDay ? usageForDay.tx / (1024 * 1024 * 1024) : 0);
        rxData.push(usageForDay ? usageForDay.rx / (1024 * 1024 * 1024) : 0);
    }

    const chartConfig = {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Скачано (GB)',
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    data: txData,
                },
                {
                    label: 'Отправлено (GB)',
                    backgroundColor: 'rgba(255, 99, 132, 0.5)',
                    borderColor: 'rgb(255, 99, 132)',
                    data: rxData,
                },
            ],
        },
    };

    const chart = new ChartJsImage()
        // @ts-ignore
        .chart(chartConfig)
        // @ts-ignore
        .width(800)
        // @ts-ignore
        .height(400)
        .backgroundColor('white');
    return await chart.toBuffer();
}

export async function generateTopUsersChart(userUsage: { name: string, usage: number }[]): Promise<Buffer> {
    const topUsers = userUsage.slice(0, 10).reverse();

    const labels = topUsers.map(u => u.name);
    const data = topUsers.map(u => u.usage / (1024 * 1024 * 1024));

    const chartConfig = {
        type: 'horizontalBar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Всего использовано (GB)',
                    backgroundColor: 'rgba(75, 192, 192, 0.5)',
                    borderColor: 'rgb(75, 192, 192)',
                    borderWidth: 1,
                    data: data,
                },
            ],
        },
        options: {
            scales: {
                xAxes: [{
                    ticks: {
                        beginAtZero: true
                    },
                    scaleLabel: {
                        display: true,
                        labelString: 'Трафик (GB)'
                    }
                }]
            },
            legend: {
                display: false
            }
        }
    };

    const chart = new ChartJsImage()
        // @ts-ignore
        .chart(chartConfig)
        // @ts-ignore
        .width(800)
        // @ts-ignore
        .height(500)
        .backgroundColor('white');

    return await chart.toBuffer();
}