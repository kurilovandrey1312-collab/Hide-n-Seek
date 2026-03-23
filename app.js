// --- ИНИЦИАЛИЗАЦИЯ ---
let peer = null;
let hostConnection = null; // Для клиента: связь с хостом
let clientConnections = {}; // Для хоста: связи с клиентами

let isHost = false;
let myId = null;
let myName = '';
let myRole = 'hider';
let isAlive = true;
let currentDanger = -1;

let map = null;
let markers = {};
let geoWatchId = null;

// --- АУДИО ---
const audio = {
    danger0: new Audio('files/danger_0.mp3'),
    danger1: new Audio('files/danger_1.mp3'),
    danger2: new Audio('files/danger_2.mp3'),
    danger3: new Audio('files/danger_3.mp3'),
    scream: new Audio('files/impostor_scream.ogg'),
    transform: new Audio('files/impostor_transform.ogg'),
    hideTime: new Audio('files/hide_time.ogg'),
    ping: new Audio('files/ping.ogg')
};
['danger0', 'danger1', 'danger2', 'danger3'].forEach(k => audio[k].loop = true);

function stopAllDangerSounds() {
    ['danger0', 'danger1', 'danger2', 'danger3'].forEach(k => { audio[k].pause(); audio[k].currentTime = 0; });
}

// --- УТИЛИТЫ ---
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// --- P2P СЕТЬ (ОБЩАЯ) ---
function initPeer(onOpenCallback) {
    myName = document.getElementById('playerName').value || 'Игрок';
    peer = new Peer(); // Используем публичный сервер PeerJS
    peer.on('open', id => {
        myId = id;
        onOpenCallback(id);
        initGeolocation();
    });
    peer.on('error', err => alert('Ошибка сети: ' + err.type));
}

function sendToHost(type, payload) {
    if (isHost) HostEngine.handleMessage(myId, type, payload);
    else if (hostConnection) hostConnection.send({ type, payload });
}

// Обработка входящих сообщений от Хоста к Клиенту
function handleHostCommand(data) {
    const { type, payload } = data;

    if (type === 'lobby_update') {
        const list = document.getElementById('playersList');
        list.innerHTML = '';
        document.getElementById('playerCount').innerText = Object.keys(payload).length;
        Object.values(payload).forEach(p => { list.innerHTML += `<li>${p.name} ${p.id === myId ? '(Ты)' : ''}</li>`; });
        if (isHost) updateSeekerSelect(payload);
    }
    else if (type === 'game_started') {
        myRole = payload.players[myId].role;
        isAlive = true;
        showScreen('screen-countdown');
        stopAllDangerSounds();
        audio.danger0.play();
        
        let time = payload.hideTime;
        const timerEl = document.getElementById('countdownTimer');
        const int = setInterval(() => {
            time--; timerEl.innerText = time;
            if (time <= 0) clearInterval(int);
        }, 1000);
    }
    else if (type === 'hunt_started') {
        stopAllDangerSounds();
        if (myRole === 'hider') { audio.scream.play(); showScreen('screen-game-hider'); } 
        else { audio.transform.play(); showScreen('screen-game-seeker'); }
    }
    else if (type === 'danger_update') {
        if (myRole !== 'hider' || !isAlive) return;
        const img = document.getElementById('dangerImg');
        if (currentDanger !== payload.level) {
            currentDanger = payload.level;
            stopAllDangerSounds();
            img.classList.remove('shake');
            if (payload.level === 0) { audio.danger0.play(); img.src = 'files/danger_0.png'; }
            else if (payload.level === 1) { audio.danger1.play(); img.src = 'files/danger_1.png'; }
            else if (payload.level === 2) { audio.danger2.play(); img.src = 'files/danger_3.png'; img.classList.add('shake'); }
            else if (payload.level === 3) { audio.danger2.play(); img.src = 'files/danger_3.png'; img.classList.add('shake'); }
        }
    }
    else if (type === 'seeker_view') {
        if (myRole !== 'seeker') return;
        const list = document.getElementById('targetsList');
        list.innerHTML = '';
        payload.forEach(t => {
            list.innerHTML += `
                <div class="target-card">
                    <span>${t.name} - ${Math.round(t.distance)}м</span>
                    <button class="btn-kill ${t.canKill ? 'active' : ''}" onclick="sendToHost('kill', '${t.id}')">
                        <img src="files/kill.png" alt="KILL">
                    </button>
                </div>`;
        });
    }
    else if (type === 'player_killed') {
        if (payload === myId) {
            isAlive = false;
            stopAllDangerSounds();
            initMap(); showScreen('screen-map');
        }
    }
    else if (type === 'last_hunt_started') {
        audio.hideTime.play();
        if (myRole === 'seeker') { initMap(); showScreen('screen-map'); }
    }
    else if (type === 'last_hunt_ping') {
        if (myRole === 'seeker') {
            audio.ping.play();
            payload.forEach(c => {
                const circle = L.circleMarker([c.lat, c.lon], { color: 'red', radius: 8 }).addTo(map);
                setTimeout(() => map.removeLayer(circle), 5000);
            });
        }
    }
    else if (type === 'map_update') {
        if (isAlive && myRole !== 'seeker') return;
        payload.forEach(p => {
            const iconUrl = p.role === 'seeker' ? 
                (p.isMoving ? 'files/seeker_run.webp' : 'files/seeker_idle.webp') : 
                (p.isMoving ? 'files/character_walk.gif' : 'files/player.png');
            
            const classFlip = p.heading === 'left' ? 'flip-horizontal' : '';
            const icon = L.divIcon({ className: 'map-icon', html: `<img src="${iconUrl}" class="${classFlip}">` });
            
            if (markers[p.id]) { markers[p.id].setLatLng([p.lat, p.lon]); markers[p.id].setIcon(icon); } 
            else { markers[p.id] = L.marker([p.lat, p.lon], { icon }).addTo(map); }
        });
    }
    else if (type === 'game_over') {
        stopAllDangerSounds(); showScreen('screen-end');
        const resEl = document.getElementById('endResult');
        resEl.className = '';
        if (payload.winner === 'hiders_win') {
            resEl.innerText = myRole === 'seeker' ? "ПОРАЖЕНИЕ" : "ПОБЕДА";
            resEl.classList.add(myRole === 'seeker' ? 'win-red' : 'win-blue');
        } else {
            resEl.innerText = myRole === 'seeker' ? "ПОБЕДА" : "ПОРАЖЕНИЕ";
            resEl.classList.add(myRole === 'seeker' ? 'win-red' : 'win-blue');
        }
        if (payload.startPos && map) {
            L.marker([payload.startPos.lat, payload.startPos.lon], { title: "Старт" }).addTo(map);
            map.setView([payload.startPos.lat, payload.startPos.lon], 16);
        }
    }
}

// --- КЛИЕНТ (ПРИСОЕДИНИТЬСЯ) ---
function joinGame() {
    const hostId = document.getElementById('joinId').value;
    if (!hostId) return;
    initPeer(() => {
        hostConnection = peer.connect(hostId);
        hostConnection.on('open', () => {
            showScreen('screen-lobby');
            document.getElementById('clientWaiting').classList.remove('hidden');
            hostConnection.send({ type: 'join', payload: myName });
        });
        hostConnection.on('data', data => handleHostCommand(data));
        hostConnection.on('close', () => alert("Хост отключился!"));
    });
}

function initGeolocation() {
    if ("geolocation" in navigator) {
        geoWatchId = navigator.geolocation.watchPosition(
            (pos) => sendToHost('location', { lat: pos.coords.latitude, lon: pos.coords.longitude }),
            (err) => console.error(err), { enableHighAccuracy: true }
        );
    } else alert("GPS не поддерживается!");
}

function initMap() {
    if (!map) {
        map = L.map('map').setView([55.751244, 37.618423], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    }
}

// --- ХОСТ (ВИРТУАЛЬНЫЙ СЕРВЕР) ---
function createGame() {
    isHost = true;
    initPeer((id) => {
        showScreen('screen-lobby');
        document.getElementById('hostControls').classList.remove('hidden');
        document.getElementById('roomIdDisplay').innerText = id;
        HostEngine.addPlayer(myId, myName); // Добавляем себя
        
        peer.on('connection', conn => {
            clientConnections[conn.peer] = conn;
            conn.on('data', data => HostEngine.handleMessage(conn.peer, data.type, data.payload));
            conn.on('close', () => HostEngine.removePlayer(conn.peer));
        });
    });
}

function updateSeekerSelect(players) {
    const select = document.getElementById('setSeeker');
    const currVal = select.value;
    select.innerHTML = '<option value="random">Случайно</option>';
    Object.values(players).forEach(p => select.innerHTML += `<option value="${p.id}">${p.name}</option>`);
    select.value = currVal || 'random';
}

function startGame() { HostEngine.startGame(); }

// Ядро игры (работает только на устройстве Хоста)
const HostEngine = {
    players: {},
    state: 'LOBBY',
    settings: {},
    timers: {},
    startLocation: null,

    broadcast(type, payload) {
        handleHostCommand({type, payload}); // Отправляем себе
        Object.values(clientConnections).forEach(conn => conn.send({type, payload})); // Отправляем клиентам
    },
    
    sendTo(peerId, type, payload) {
        if (peerId === myId) handleHostCommand({type, payload});
        else if (clientConnections[peerId]) clientConnections[peerId].send({type, payload});
    },

    handleMessage(peerId, type, payload) {
        if (type === 'join') {
            if (Object.keys(this.players).length >= 10) return;
            this.players[peerId] = { id: peerId, name: payload, role: 'hider', lat: 0, lon: 0, isAlive: true, isMoving: false, heading: 'right' };
            this.broadcast('lobby_update', this.players);
        }
        else if (type === 'location') {
            if (!this.players[peerId]) return;
            const p = this.players[peerId];
            if (p.lon !== 0) {
                p.heading = payload.lon > p.lon ? 'right' : 'left';
                p.isMoving = getDistance(p.lat, p.lon, payload.lat, payload.lon) > 1;
            }
            p.lat = payload.lat; p.lon = payload.lon;
            if (this.state === 'LOBBY' && peerId === myId) this.startLocation = payload;
        }
        else if (type === 'kill') {
            if (this.state !== 'PLAYING' && this.state !== 'LAST_HUNT') return;
            const seeker = this.players[peerId];
            const hider = this.players[payload];
            if (seeker && hider && hider.isAlive && seeker.role === 'seeker') {
                if (getDistance(seeker.lat, seeker.lon, hider.lat, hider.lon) <= 5) {
                    hider.isAlive = false;
                    this.broadcast('player_killed', payload);
                    if (Object.values(this.players).filter(p => p.role==='hider' && p.isAlive).length === 0) this.endGame('seeker_wins');
                }
            }
        }
    },

    removePlayer(id) {
        delete this.players[id];
        delete clientConnections[id];
        this.broadcast('lobby_update', this.players);
    },

    startGame() {
        this.state = 'HIDING';
        this.settings = {
            hideTime: parseInt(document.getElementById('setHide').value),
            gameTime: parseInt(document.getElementById('setGame').value) * 60,
            lastHuntTime: parseInt(document.getElementById('setLastHunt').value) * 60,
            seekerId: document.getElementById('setSeeker').value
        };

        let seekerId = this.settings.seekerId;
        if (seekerId === 'random') {
            const ids = Object.keys(this.players);
            seekerId = ids[Math.floor(Math.random() * ids.length)];
        }
        for (let id in this.players) {
            this.players[id].role = (id === seekerId) ? 'seeker' : 'hider';
            this.players[id].isAlive = true;
        }

        this.broadcast('game_started', { hideTime: this.settings.hideTime, players: this.players });
        this.timers.hide = setTimeout(() => this.startHunt(), this.settings.hideTime * 1000);
    },

    startHunt() {
        this.state = 'PLAYING';
        this.broadcast('hunt_started', {});
        this.timers.game = setTimeout(() => this.startLastHunt(), this.settings.gameTime * 1000);
        this.timers.loop = setInterval(() => this.gameLoop(), 1000);
    },

    startLastHunt() {
        this.state = 'LAST_HUNT';
        this.broadcast('last_hunt_started', {});
        clearTimeout(this.timers.game);
        
        this.timers.ping = setInterval(() => {
            const hiders = Object.values(this.players).filter(p => p.role==='hider' && p.isAlive).map(h => ({lat: h.lat, lon: h.lon}));
            this.broadcast('last_hunt_ping', hiders);
        }, 10000); // Пинг каждые 10 сек

        this.timers.lastHuntEnd = setTimeout(() => this.endGame('hiders_win'), this.settings.lastHuntTime * 1000);
    },

    gameLoop() {
        const seeker = Object.values(this.players).find(p => p.role === 'seeker');
        const hiders = Object.values(this.players).filter(p => p.role === 'hider' && p.isAlive);
        if (!seeker || hiders.length === 0) return;

        let seekerView = [];
        hiders.forEach(hider => {
            const dist = getDistance(seeker.lat, seeker.lon, hider.lat, hider.lon);
            seekerView.push({ id: hider.id, name: hider.name, distance: dist, canKill: dist <= 5 });
            
            let dangerLvl = 0;
            if (dist < 5) dangerLvl = 3;
            else if (dist >= 5 && dist <= 15) dangerLvl = 2;
            else if (dist > 15 && dist <= 25) dangerLvl = 1;
            
            this.sendTo(hider.id, 'danger_update', { level: dangerLvl });
        });

        this.sendTo(seeker.id, 'seeker_view', seekerView);
        
        const allData = Object.values(this.players);
        Object.values(this.players).forEach(p => {
            if (!p.isAlive || (p.role === 'seeker' && this.state === 'LAST_HUNT')) {
                this.sendTo(p.id, 'map_update', allData);
            }
        });
    },

    endGame(reason) {
        this.state = 'END';
        Object.values(this.timers).forEach(t => { clearTimeout(t); clearInterval(t); });
        this.broadcast('game_over', { winner: reason, startPos: this.startLocation });
    }
};
