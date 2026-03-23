let peer = null;
let hostConn = null; // Для клиента
let clientConns = {}; // Для хоста
let isHost = false;
let myId = null;
let myName = '';
let myRole = 'hider';
let isAlive = true;
let currentDanger = -1;
let map = null;
let markers = {};
let startLocation = null;

// Аудио файлы
const sounds = {
    danger0: new Audio('files/danger_0.mp3'),
    danger1: new Audio('files/danger_1.mp3'),
    danger2: new Audio('files/danger_2.mp3'),
    scream: new Audio('files/impostor_scream.ogg'),
    transform: new Audio('files/impostor_transform.ogg'),
    hideTime: new Audio('files/hide_time.ogg'),
    ping: new Audio('files/ping.ogg')
};
['danger0', 'danger1', 'danger2'].forEach(s => sounds[s].loop = true);

function stopAllSounds() {
    Object.values(sounds).forEach(s => { s.pause(); s.currentTime = 0; });
}

// Показ экранов
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

// Математика GPS
function getDist(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const d1 = lat1 * Math.PI/180;
    const d2 = lat2 * Math.PI/180;
    const df = (lat2-lat1) * Math.PI/180;
    const dl = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(df/2)**2 + Math.cos(d1)*Math.cos(d2)*Math.sin(dl/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- СЕТЬ (PEERJS) ---
function initPeer(callback) {
    myName = document.getElementById('playerName').value || 'Игрок_' + Math.floor(Math.random()*999);
    // Настройка для минимизации server-error
    peer = new Peer(undefined, { debug: 1 });
    
    peer.on('open', id => {
        myId = id;
        callback(id);
        startGPS();
    });

    peer.on('error', err => {
        console.error("PeerJS Error:", err.type);
        if(err.type === 'server-error') alert("Ошибка сервера сигналов. Попробуй обновить.");
    });
}

function sendToHost(type, payload) {
    if (isHost) Engine.onMsg(myId, type, payload);
    else if (hostConn) hostConn.send({ type, payload });
}

function startGPS() {
    navigator.geolocation.watchPosition(
        p => sendToHost('pos', { lat: p.coords.latitude, lon: p.coords.longitude }),
        e => console.error("GPS Error"), { enableHighAccuracy: true }
    );
}

// --- ЛОГИКА КЛИЕНТА ---
function joinGame() {
    const rid = document.getElementById('joinId').value;
    if (!rid) return alert("Введи ID хоста!");
    initPeer(() => {
        hostConn = peer.connect(rid);
        hostConn.on('open', () => {
            showScreen('screen-lobby');
            document.getElementById('clientWaiting').classList.remove('hidden');
            hostConn.send({ type: 'join', payload: myName });
        });
        hostConn.on('data', data => ClientHandle(data));
    });
}

function ClientHandle(data) {
    const { type, payload } = data;
    if (type === 'lobby') {
        const list = document.getElementById('playersList');
        list.innerHTML = '';
        document.getElementById('playerCount').innerText = Object.keys(payload).length;
        Object.values(payload).forEach(p => list.innerHTML += `<li>${p.name} ${p.id===myId?'(ТЫ)':''}</li>`);
        if (isHost) updateSeekerSelect(payload);
    } 
    else if (type === 'start_hide') {
        myRole = payload.players[myId].role;
        showScreen('screen-countdown');
        stopAllSounds(); sounds.danger0.play();
        let t = payload.time;
        const timer = setInterval(() => {
            t--; document.getElementById('countdownTimer').innerText = t;
            if(t<=0) clearInterval(timer);
        }, 1000);
    }
    else if (type === 'hunt') {
        stopAllSounds();
        if (myRole === 'hider') { sounds.scream.play(); showScreen('screen-game-hider'); }
        else { sounds.transform.play(); showScreen('screen-game-seeker'); }
    }
    else if (type === 'danger') {
        if (!isAlive || myRole !== 'hider') return;
        document.getElementById('distVal').innerText = Math.round(payload.dist);
        const img = document.getElementById('dangerImg');
        if (currentDanger !== payload.lvl) {
            currentDanger = payload.lvl;
            stopAllSounds(); img.classList.remove('shake');
            if (payload.lvl === 0) { sounds.danger0.play(); img.src = 'files/danger_0.png'; }
            else if (payload.lvl === 1) { sounds.danger1.play(); img.src = 'files/danger_1.png'; }
            else { sounds.danger2.play(); img.src = 'files/danger_3.png'; img.classList.add('shake'); }
        }
    }
    else if (type === 'seeker_radar') {
        if (myRole !== 'seeker') return;
        const list = document.getElementById('targetsList');
        list.innerHTML = '';
        payload.forEach(t => {
            list.innerHTML += `<div class="target-card">
                <span>${t.name}: ${Math.round(t.dist)}м</span>
                <button class="btn-kill ${t.canKill?'active':''}" onclick="sendToHost('kill','${t.id}')">
                    <img src="files/kill.png">
                </button>
            </div>`;
        });
    }
    else if (type === 'dead') {
        if (payload === myId) { isAlive = false; stopAllSounds(); initMap(); showScreen('screen-map'); }
    }
    else if (type === 'last_hunt') {
        sounds.hideTime.play();
        if (myRole === 'seeker') { initMap(); showScreen('screen-map'); }
    }
    else if (type === 'ping') {
        if (myRole === 'seeker') {
            sounds.ping.play();
            payload.forEach(c => {
                const dot = L.circleMarker([c.lat, c.lon], { color: 'red', radius: 10 }).addTo(map);
                setTimeout(() => map.removeLayer(dot), 5000);
            });
        }
    }
    else if (type === 'map_sync') {
        if (isAlive && myRole !== 'seeker') return;
        payload.forEach(p => {
            let iconImg = p.role==='seeker' ? (p.mv?'seeker_run.webp':'seeker_idle.webp') : (p.mv?'character_walk.gif':'player.png');
            let flip = p.dir==='left' ? 'flip-x' : '';
            const icon = L.divIcon({ className: 'map-icon', html: `<img src="files/${iconImg}" class="${flip}">` });
            if (markers[p.id]) { markers[p.id].setLatLng([p.lat, p.lon]); markers[p.id].setIcon(icon); }
            else markers[p.id] = L.marker([p.lat, p.lon], { icon }).addTo(map);
        });
    }
    else if (type === 'over') {
        stopAllSounds(); showScreen('screen-end');
        const txt = document.getElementById('endResultText');
        const win = (payload.winner === 'hiders' && myRole === 'hider') || (payload.winner === 'seeker' && myRole === 'seeker');
        txt.innerText = win ? "ПОБЕДА" : "ПОРАЖЕНИЕ";
        txt.className = win ? "win-blue" : "win-red";
        if (payload.start && map) { L.marker([payload.start.lat, payload.start.lon]).addTo(map); map.setView([payload.start.lat, payload.start.lon], 17); }
    }
}

// --- ЛОГИКА ХОСТА ---
function createGame() {
    isHost = true;
    initPeer(id => {
        showScreen('screen-lobby');
        document.getElementById('roomIdDisplay').innerText = id;
        document.getElementById('hostControls').classList.remove('hidden');
        Engine.addPlayer(myId, myName);
        peer.on('connection', conn => {
            clientConns[conn.peer] = conn;
            conn.on('data', d => Engine.onMsg(conn.peer, d.type, d.payload));
            conn.on('close', () => Engine.removePlayer(conn.peer));
        });
    });
}

const Engine = {
    players: {}, state: 'LOBBY', timers: {}, settings: {},
    broadcast(type, payload) {
        ClientHandle({ type, payload });
        Object.values(clientConns).forEach(c => c.send({ type, payload }));
    },
    sendTo(pid, type, payload) {
        if (pid === myId) ClientHandle({ type, payload });
        else if (clientConns[pid]) clientConns[pid].send({ type, payload });
    },
    addPlayer(id, name) {
        this.players[id] = { id, name, role:'hider', lat:0, lon:0, alive:true, mv:false, dir:'right' };
        this.broadcast('lobby', this.players);
    },
    onMsg(pid, type, payload) {
        const p = this.players[pid];
        if (type === 'join') this.addPlayer(pid, payload);
        if (type === 'pos') {
            if(!p) return;
            if(p.lat!==0) { p.dir = payload.lon > p.lon ? 'right' : 'left'; p.mv = getDist(p.lat, p.lon, payload.lat, payload.lon) > 0.5; }
            p.lat = payload.lat; p.lon = payload.lon;
            if (this.state === 'LOBBY' && pid === myId) startLocation = payload;
        }
        if (type === 'kill') {
            const hider = this.players[payload];
            if (hider && getDist(p.lat, p.lon, hider.lat, hider.lon) <= 5) {
                hider.alive = false; this.broadcast('dead', payload);
                if (Object.values(this.players).filter(x=>x.role==='hider'&&x.alive).length === 0) this.end('seeker');
            }
        }
    },
    startGame() {
        this.settings = { 
            hide: parseInt(document.getElementById('setHide').value),
            game: parseInt(document.getElementById('setGame').value)*60,
            hunt: parseInt(document.getElementById('setLastHunt').value)*60,
            sid: document.getElementById('setSeeker').value
        };
        let sid = this.settings.sid === 'random' ? Object.keys(this.players)[Math.floor(Math.random()*Object.keys(this.players).length)] : this.settings.sid;
        Object.values(this.players).forEach(p => { p.role = p.id === sid ? 'seeker' : 'hider'; p.alive = true; });
        this.broadcast('start_hide', { time: this.settings.hide, players: this.players });
        this.state = 'HIDING';
        setTimeout(() => this.beginHunt(), this.settings.hide * 1000);
    },
    beginHunt() {
        this.state = 'PLAYING'; this.broadcast('hunt', {});
        this.timers.main = setTimeout(() => this.lastHunt(), this.settings.game * 1000);
        this.timers.loop = setInterval(() => this.loop(), 1000);
    },
    lastHunt() {
        this.state = 'LAST_HUNT'; this.broadcast('last_hunt', {});
        this.timers.ping = setInterval(() => {
            const h = Object.values(this.players).filter(x=>x.role==='hider'&&x.alive).map(x=>({lat:x.lat,lon:x.lon}));
            this.broadcast('ping', h);
        }, 15000);
        setTimeout(() => this.end('hiders'), this.settings.hunt * 1000);
    },
    loop() {
        const s = Object.values(this.players).find(x=>x.role==='seeker');
        const hiders = Object.values(this.players).filter(x=>x.role==='hider' && x.alive);
        if(!s) return;
        let radar = [];
        hiders.forEach(h => {
            const d = getDist(s.lat, s.lon, h.lat, h.lon);
            radar.push({ id: h.id, name: h.name, dist: d, canKill: d<=5 });
            let lvl = d > 25 ? 0 : (d > 15 ? 1 : 2);
            this.sendTo(h.id, 'danger', { lvl, dist: d });
        });
        this.sendTo(s.id, 'seeker_radar', radar);
        const ghosts = Object.values(this.players).filter(x => !x.alive || (x.role==='seeker' && this.state==='LAST_HUNT'));
        ghosts.forEach(g => this.sendTo(g.id, 'map_sync', Object.values(this.players)));
    },
    end(win) {
        clearInterval(this.timers.loop); clearInterval(this.timers.ping);
        this.broadcast('over', { winner: win, start: startLocation });
    }
};

function updateSeekerSelect(ps) {
    const s = document.getElementById('setSeeker');
    const val = s.value;
    s.innerHTML = '<option value="random">Случайно</option>';
    Object.values(ps).forEach(p => s.innerHTML += `<option value="${p.id}">${p.name}</option>`);
    s.value = val;
}

function initMap() {
    if (map) return;
    map = L.map('map').setView([55.75, 37.61], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
}
