// api/generate-tone.js (Vercel 서버리스 함수 - API 키 은닉 및 프롬프트 보안 적용)

const rateLimitMap = new Map();
const MAX_REQUESTS_PER_HOUR = 15; // 1인당(IP 기준) 1시간 최대 15회 생성 허용
const WINDOW_MS = 60 * 60 * 1000;

const ALLOWED_OUTPUT_MODES = {
    FRFR_HEADPHONE: '헤드폰 / 오인페 / 믹서 / FRFR (AMP ON · CAB ON)',
    AMP_RETURN: '기타 앰프 FX Return / 파워앰프 (AMP ON · CAB OFF)',
    AMP_INPUT: '기타 앰프 일반 INPUT 연결 (AMP OFF · CAB OFF)'
};

const MP100_OFFICIAL_MODELS = `[Hotone Ampero MP-100 공식 매뉴얼(Firmware V3.0) 탑재 모델명]
- FX1/FX2/FX3 Dynamic: Comprosso, Comparoma 4, Blue Sustainer, Squeezer, Affinity Boost, Beefy Boost, Pristine Boost, FET Boost, Enhancer
- FX1/FX2/FX3 Freq/Wah/Pitch: Acoustic Refiner, AC Sim, Toucher, Crier, Voxy Wah, Cry Wah, Soul Press, Clean Octa, Dirty Octa, Harmony, Satisfaction
- FX1/FX2/FX3 Overdrive/Distortion: Green Drive, Yellow Drive, Swarm Drive, Super Drive, Screamood, Dr. Blues, Force Drive, Tube Clipper, Zen Garden, Direct Touch, Big Pie, Face Fuzz, Bend Fuzz, Black Tail, Plustortion, Smooth Dist, Governor, Crunchist, Purple Plexi, Panama Lead
- FX1/FX2/FX3 Modulation: Aozora Chorus, Grand Choruium, Liquid C, Aquaria M, Detune, Jetter, Pulser, Grand Vibrato, 90 Phaser, Green Phaser, Minivibe, Revolver, Helicopter, Custom Trem
- AMP Clean: Tweed Lux, Baseman Norm, Black Twin, Voxy 30HW Norm, Superb Dual Clean, Jazz Clean, Emperor Clean, Superstar Clean, Glacian Clean, Dr. 38 Clean, Hot Kitty Clean, Soloist 100 Clean
- AMP Drive: Baseman Bright, Voxy 30HW TB, Superb Dual Drive, Emperor Drive, Dr. 38 Drive, Superstar Drive, Marshell 45, Marshell 45+, Marshell 50, Marshell 50+, Hot Kitty Drive, Messe IIC+ 1, Messe IIC+ 2, Soloist 100 Crunch, Marshell 800, Fryman B1, Glacian Drive
- AMP HiGain: Marshell 900, Dizzle VH B, Engle Saga 1, Powerengle Lead, Fryman HB, Eddie 51, Soloist 100 Lead, Messe IV Lead 1, Tangerine R100, Rector Dual V, Rector Dual M, Boger XT Blue M, Boger XT Red M
- NR: Smart Gate, Fast Gate, Custom Gate
- CAB: Tweed Lux 1x12, Black Lux 1x12, Voxy 1x12, Voxy 2x12, Jazz Twin 2x12, Black Twin 2x12, UK Green 2x12, Baseman 4x10, UK Lead 4x12, UK Green 4x12, UK Modern 4x12, Eddie 4x12, Rector 4x12, Boger 4x12, Engle 4x12, Tang 4x12, UK T75 4x12
- CAB Mic: OFF, Dyn 57, Dyn 58, Dyn 421, Dyn 609, Con U67, Con U87, Rib 121
- EQ: Guitar EQ 1, Guitar EQ 2, Para EQ, Graphic EQ, V-EQ
- DLY: Sweetie, Recaller, Pure Eko, Analog Eko, Ekopress 80, Mag Eko, Tube Eko, Dual Eko, Ping Pong, Multi Head, Slapback, Vintage Rack, Ekoverb
- RVB: Hall, Church, Plate, Spring, Izumi, Northstar, Oceandeep, Sweet Space, Shimmer`;

const MP100_DRUM_PATTERNS = `[Hotone Ampero MP-100 내장 드럼 머신 리듬 번호 (매뉴얼 p.39-41)]
- 8 Beat (4/4): #0 8-Beat 1 ~ #9 8-Beat 10
- 16 Beat (4/4): #10 16-Beat 1 ~ #19 16-Beat 10
- 4 Beat (4/4): #20 4-Beat 1 ~ #29 4-Beat 10
- Rock (4/4): #30 Roots, #31 Classic Rock, #32 Pop Rock, #33 Slow Rock, #34 Rock Shuffle, #35 Rock Ballad, #36 Punk, #37 New Wave, #38 Hard Rock, #39 Metal
- Funk/Soul (4/4): #40 Funk, #41 Funk Rock, #42 Electro Funk, #43 Soul, #44 R&B
- Jazz (4/4): #45 Jazz, #46 Big Band, #47 Fusion, #48 Swing, #49 Dixieland
- Blues/Country: #50 Blues (4/4), #51 Country (4/4), #52 Folk (4/4), #53 Rockabilly (4/4), #54 Bluegrass (2/4)
- Latin: #55 Bossa nova, #56 Rumba, #57 Samba, #58 Cha Cha, #59 Tango, #60 Reggae, #62 Latin Pop, #63 Latin Rock
- Electronic: #65 Hip Hop, #66 Trip Hop, #67 Techno, #68 Break Beat, #69 Drum n' Bass
- World/Odd: #70 Waltz (3/4), #77 Ska (4/4), #80 3/4 Beat1 (3/4), #82 6/8 Beat1 (6/8), #84 Beat 5/4 (5/4), #93 Metronome 4/4 (4/4)`;

function checkRateLimit(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (!record || now > record.resetTime) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
        return { allowed: true };
    }
    if (record.count >= MAX_REQUESTS_PER_HOUR) {
        return { allowed: false };
    }
    record.count += 1;
    return { allowed: true };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        'unknown';

    if (!checkRateLimit(clientIp).allowed) {
        return res.status(429).json({
            error: '시간당 무료 AI 생성 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'
        });
    }

    const body = req.body || {};
    const songQuery = String(body.songQuery || '').trim().slice(0, 120);
    const pickup = String(body.pickup || '원곡 기준 자동').trim().slice(0, 50);
    const part = String(body.part || '메인 톤 (리듬/리프 중심)').trim().slice(0, 50);
    const outputMode = ALLOWED_OUTPUT_MODES[body.outputMode] ? body.outputMode : 'FRFR_HEADPHONE';
    const moodNote = String(body.moodNote || '').trim().slice(0, 120);

    if (!songQuery) {
        return res.status(400).json({ error: '곡명과 아티스트를 입력해 주세요.' });
    }

    const outputRuleText = outputMode === 'AMP_INPUT'
        ? '사용자는 실제 기타 앰프의 일반 INPUT에 연결합니다. 매뉴얼 p.17에 따라 AMP 모듈과 CAB 모듈은 반드시 enabled: false로 설정하고, 드라이브/이펙터 페달 중심으로 톤을 구성하세요.'
        : outputMode === 'AMP_RETURN'
            ? '사용자는 실제 기타 앰프의 FX Loop Return(또는 파워앰프)에 연결합니다. 매뉴얼 p.17에 따라 AMP 모듈은 enabled: true로 사용하되, CAB 모듈은 반드시 enabled: false로 설정하세요.'
            : '사용자는 헤드폰/오인페/믹서/FRFR 스피커에 연결합니다. 매뉴얼 p.18에 따라 AMP 모듈과 CAB 모듈을 모두 enabled: true로 설정하세요.';

    const systemPrompt = `당신은 Hotone Ampero MP-100 (Firmware V3.0) 공식 매뉴얼을 완벽히 숙지한 프로 기타 테크니션이자 톤 엔지니어입니다.
사용자가 입력한 곡과 조건에 맞춰 MP-100의 9개 시그널 체인(FX1, FX2, AMP, NR, CAB, EQ, FX3, DLY, RVB) 세팅을 한국어로 정확하게 추천하세요.
1. 모델명은 반드시 아래 MP-100 공식 매뉴얼(V3.0) 탑재 모델명 목록에서만 선택하세요.
2. 원곡에서 실제로 사용된 기타, 앰프, 이펙터 정보를 originalGear에 사실적으로 정리하세요.
3. 신뢰도 등급(confidenceLevel)을 ORIGINAL_RIG, ARTIST_STYLE, GENRE_ESTIMATE 중 하나로 정직하게 분류하세요.
4. modules 배열은 반드시 FX1, FX2, AMP, NR, CAB, EQ, FX3, DLY, RVB 순서대로 9개 모두 포함하고, enabled가 false인 모듈은 modelName을 "OFF", params를 []로 두세요.
5. ${outputRuleText}
6. hardwareSetup에 EXP 1 타겟, CTRL 풋스위치 추천, 내장 드럼 머신 패턴 번호·이름·박자·BPM을 추천하세요.

${MP100_OFFICIAL_MODELS}

${MP100_DRUM_PATTERNS}`;

    const userPrompt = `다음 곡을 Hotone Ampero MP-100으로 연주하기 위한 톤 세팅을 만들어 주세요:
- 곡 / 아티스트: ${songQuery}
- 사용 기타/픽업: ${pickup}
- 연주 파트: ${part}
- 출력 환경: ${ALLOWED_OUTPUT_MODES[outputMode]}
- 원하는 톤 분위기 보조 키워드: ${moodNote || '없음 (원곡 기준)'}`;

    const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    songTitle: { type: 'STRING' },
                    artist: { type: 'STRING' },
                    patchName: { type: 'STRING' },
                    tuning: { type: 'STRING' },
                    bpm: { type: 'INTEGER' },
                    confidenceLevel: { type: 'STRING', enum: ['ORIGINAL_RIG', 'ARTIST_STYLE', 'GENRE_ESTIMATE'] },
                    confidenceReason: { type: 'STRING' },
                    originalGear: {
                        type: 'OBJECT',
                        properties: {
                            guitar: { type: 'STRING' },
                            amp: { type: 'STRING' },
                            effects: { type: 'STRING' },
                            notes: { type: 'STRING' }
                        },
                        required: ['guitar', 'amp', 'effects', 'notes']
                    },
                    toneSummary: { type: 'STRING' },
                    guitarTip: { type: 'STRING' },
                    hardwareSetup: {
                        type: 'OBJECT',
                        properties: {
                            exp1: { type: 'STRING' },
                            ctrl: { type: 'STRING' },
                            drum: {
                                type: 'OBJECT',
                                properties: {
                                    number: { type: 'INTEGER' },
                                    name: { type: 'STRING' },
                                    timeSig: { type: 'STRING' },
                                    bpm: { type: 'INTEGER' },
                                    note: { type: 'STRING' }
                                },
                                required: ['number', 'name', 'timeSig', 'bpm', 'note']
                            }
                        },
                        required: ['exp1', 'ctrl', 'drum']
                    },
                    modules: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                slot: { type: 'STRING', enum: ['FX1', 'FX2', 'AMP', 'NR', 'CAB', 'EQ', 'FX3', 'DLY', 'RVB'] },
                                enabled: { type: 'BOOLEAN' },
                                category: { type: 'STRING' },
                                modelName: { type: 'STRING' },
                                basedOn: { type: 'STRING' },
                                tip: { type: 'STRING' },
                                params: {
                                    type: 'ARRAY',
                                    items: {
                                        type: 'OBJECT',
                                        properties: {
                                            name: { type: 'STRING' },
                                            value: { type: 'NUMBER' },
                                            displayValue: { type: 'STRING' }
                                        },
                                        required: ['name', 'value', 'displayValue']
                                    }
                                }
                            },
                            required: ['slot', 'enabled', 'category', 'modelName', 'basedOn', 'tip', 'params']
                        }
                    }
                },
                required: [
                    'songTitle', 'artist', 'patchName', 'tuning', 'bpm',
                    'confidenceLevel', 'confidenceReason', 'originalGear',
                    'toneSummary', 'guitarTip', 'hardwareSetup', 'modules'
                ]
            }
        }
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    try {
        const geminiRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await geminiRes.json();

        if (!geminiRes.ok) {
            console.error('Gemini API Error:', data);
            return res.status(geminiRes.status).json({
                error: data?.error?.message || 'AI 응답 생성 중 오류가 발생했습니다.'
            });
        }

        return res.status(200).json(data);
    } catch (err) {
        console.error('Server Proxy Error:', err);
        return res.status(500).json({ error: 'AI 서버와 통신하지 못했습니다.' });
    }
};
