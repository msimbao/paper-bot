const fs = require('fs');

class MarketConditionAnalyzer {
    constructor(symbol, timeframe) {
        this.symbol = symbol;
        this.timeframe = timeframe;
    }

    async analyzeCurrentConditions() {
        // Get last 24 hours of data
        const data = await this.fetchRecentData(480); // ~8 hours for 1m candles
        
        if (data.length < 100) {
            return { suitable: false, reason: 'Insufficient data' };
        }

        const analysis = {
            volume: this.analyzeVolume(data),
            volatility: this.analyzeVolatility(data),
            trend: this.analyzeTrend(data),
            spread: this.analyzeSpread(data),
            timestamp: new Date().toISOString()
        };

        analysis.suitability = this.determineSuitability(analysis);
        
        return analysis;
    }

    analyzeVolume(data) {
        const volumes = data.map(d => d.volume);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const recentVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        
        const volumeRatio = recentVolume / avgVolume;
        
        return {
            average: avgVolume,
            recent: recentVolume,
            ratio: volumeRatio,
            status: volumeRatio > 0.7 ? 'Normal' : 'Low',
            warning: volumeRatio < 0.5
        };
    }

    analyzeVolatility(data) {
        const prices = data.map(d => d.close);
        const returns = [];
        
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
        }
        
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance) * 100;
        
        return {
            value: volatility,
            status: volatility > 2 ? 'High' : volatility > 0.5 ? 'Normal' : 'Low',
            suitable: volatility > 0.3 && volatility < 3
        };
    }

    analyzeTrend(data) {
        const prices = data.map(d => d.close);
        const sma20 = this.calculateSMA(prices, 20);
        const sma50 = this.calculateSMA(prices, 50);
        
        const currentPrice = prices[prices.length - 1];
        const trendStrength = Math.abs((currentPrice - sma50) / sma50) * 100;
        
        let trendType = 'Ranging';
        if (sma20 > sma50 * 1.02) trendType = 'Strong Uptrend';
        else if (sma20 > sma50 * 1.005) trendType = 'Uptrend';
        else if (sma20 < sma50 * 0.98) trendType = 'Strong Downtrend';
        else if (sma20 < sma50 * 0.995) trendType = 'Downtrend';
        
        return {
            type: trendType,
            strength: trendStrength,
            suitable: trendType.includes('Ranging') || trendType.includes('Uptrend')
        };
    }

    analyzeSpread(data) {
        const spreads = data.map(d => ((d.high - d.low) / d.close) * 100);
        const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
        
        return {
            average: avgSpread,
            status: avgSpread < 0.1 ? 'Tight' : avgSpread < 0.3 ? 'Normal' : 'Wide',
            warning: avgSpread > 0.5
        };
    }

    determineSuitability(analysis) {
        const issues = [];
        let score = 100;

        if (analysis.volume.warning) {
            issues.push('Very low volume - high slippage risk');
            score -= 30;
        } else if (analysis.volume.status === 'Low') {
            issues.push('Below-average volume');
            score -= 15;
        }

        if (!analysis.volatility.suitable) {
            if (analysis.volatility.value < 0.3) {
                issues.push('Too low volatility - limited profit opportunities');
                score -= 25;
            } else {
                issues.push('Excessive volatility - high risk');
                score -= 20;
            }
        }

        if (analysis.trend.type.includes('Strong')) {
            issues.push('Strong trend - RSI mean reversion may underperform');
            score -= 20;
        }

        if (analysis.spread.warning) {
            issues.push('Wide spreads - high transaction costs');
            score -= 15;
        }

        return {
            score: Math.max(0, score),
            recommendation: score >= 70 ? 'Favorable' : score >= 50 ? 'Caution' : 'Unfavorable',
            issues: issues,
            suitable: score >= 50
        };
    }

    calculateSMA(data, period) {
        if (data.length < period) return data[data.length - 1];
        const slice = data.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    async fetchRecentData(limit) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${this.symbol}&interval=${this.timeframe}&limit=${limit}`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            return data.map(kline => ({
                time: new Date(kline[0]),
                open: parseFloat(kline[1]),
                high: parseFloat(kline[2]),
                low: parseFloat(kline[3]),
                close: parseFloat(kline[4]),
                volume: parseFloat(kline[5])
            }));
        } catch (error) {
            console.error('Error fetching data:', error);
            return [];
        }
    }

    printReport(analysis) {
        console.log('\n=== MARKET CONDITION ANALYSIS ===');
        console.log(`Symbol: ${this.symbol} | Timeframe: ${this.timeframe}`);
        console.log(`Time: ${analysis.timestamp}\n`);
        
        console.log('VOLUME:');
        console.log(`  Status: ${analysis.volume.status}`);
        console.log(`  Ratio: ${(analysis.volume.ratio * 100).toFixed(1)}% of average`);
        if (analysis.volume.warning) console.log('  ⚠️  WARNING: Very low volume\n');
        else console.log('');
        
        console.log('VOLATILITY:');
        console.log(`  Status: ${analysis.volatility.status}`);
        console.log(`  Value: ${analysis.volatility.value.toFixed(3)}%`);
        console.log(`  Suitable: ${analysis.volatility.suitable ? 'Yes' : 'No'}\n`);
        
        console.log('TREND:');
        console.log(`  Type: ${analysis.trend.type}`);
        console.log(`  Strength: ${analysis.trend.strength.toFixed(2)}%`);
        console.log(`  Suitable: ${analysis.trend.suitable ? 'Yes' : 'No'}\n`);
        
        console.log('SPREAD:');
        console.log(`  Average: ${analysis.spread.average.toFixed(3)}%`);
        console.log(`  Status: ${analysis.spread.status}\n`);
        
        console.log('=== RECOMMENDATION ===');
        console.log(`Score: ${analysis.suitability.score}/100`);
        console.log(`Recommendation: ${analysis.suitability.recommendation}`);
        
        if (analysis.suitability.issues.length > 0) {
            console.log('\nIssues:');
            analysis.suitability.issues.forEach(issue => console.log(`  - ${issue}`));
        }
        
        console.log('\n' + '='.repeat(35) + '\n');
    }
}

// Usage
async function checkBeforeTrading() {
    const analyzer = new MarketConditionAnalyzer('NEARUSDT', '3m');
    const analysis = await analyzer.analyzeCurrentConditions();
    
    analyzer.printReport(analysis);
    
    if (analysis.suitability.suitable) {
        console.log('✓ Conditions appear favorable for trading');
    } else {
        console.log('✗ Consider waiting for better conditions');
    }
    
    return analysis;
}

checkBeforeTrading();