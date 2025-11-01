import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8nmvproducao.space/webhook/paine-disparo';
const JWT_SECRET = process.env.JWT_SECRET || 'teste123';
const PANEL_USER = process.env.PANEL_USER || 'cliente';
const PANEL_PASS = process.env.PANEL_PASS || '123456';
const N8N_PROGRESS_TOKEN = process.env.N8N_PROGRESS_TOKEN || 'n8n-token';

// Middleware
app.use(cors());
app.use(express.json());

// Store de progresso em memória
let progressStore = {
  total: 0,
  sent: 0,
  campaignName: '',
  status: 'idle',
  leads: [], // Array de leads com status individual
  tempoParaEnvio: null, // Tempo em segundos até próximo envio
  timestampRecebido: null // Timestamp quando recebeu o tempo
};

// Lista de clientes SSE conectados
const sseClients = new Set();

// Middleware de autenticação JWT
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// Middleware de autenticação do n8n
const n8nAuth = (req, res, next) => {
  const token = req.headers['x-n8n-token'];

  if (!token || token !== N8N_PROGRESS_TOKEN) {
    return res.status(401).json({ error: 'Token n8n inválido' });
  }

  next();
};

// Função para fazer broadcast do progresso para todos os clientes SSE
const broadcastProgress = () => {
  const data = JSON.stringify(progressStore);
  
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      // Remove cliente se houver erro ao enviar
      sseClients.delete(client);
    }
  });
};

// Rotas públicas
app.get('/', (req, res) => {
  res.json({ ok: true });
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (username === PANEL_USER && password === PANEL_PASS) {
    const token = jwt.sign(
      { username },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({ token, username });
  }

  return res.status(401).json({ error: 'Credenciais inválidas' });
});

// POST /api/leads (PROTEGIDA)
app.post('/api/leads', authMiddleware, async (req, res) => {
  try {
    // Verifica se já existe uma campanha em execução
    if (progressStore.status === 'running') {
      return res.status(400).json({ error: 'Já existe uma campanha em execução. Aguarde a finalização ou pare a campanha atual.' });
    }

    const { campaignName, leads } = req.body;

    if (!campaignName || !leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    // Cria array de leads com status inicial
    const leadsWithStatus = leads.map(lead => ({
      name: lead.name,
      phone: lead.phone,
      status: 'pending', // pending, success, error
      sentAt: null
    }));

    // Atualiza o progresso inicial
    progressStore = {
      total: leads.length,
      sent: 0,
      campaignName: campaignName,
      status: 'running',
      leads: leadsWithStatus
    };

    // Faz broadcast do progresso inicial
    broadcastProgress();

    // Envia leads para o n8n
    const payload = {
      campaignName,
      leads
    };

    try {
      await axios.post(N8N_WEBHOOK_URL, payload);
    } catch (error) {
      console.error('Erro ao enviar para n8n:', error.message);
      // Continua mesmo se der erro no n8n
    }

    return res.json({
      message: 'Leads enviados ao n8n para processamento.',
      total: leads.length
    });
  } catch (error) {
    console.error('Erro ao processar leads:', error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/progress (chamado pelo n8n)
app.post('/api/progress', n8nAuth, (req, res) => {
  const { campaignName, sent, total, status, lastLead, lastPhone, tempoParaEnvio } = req.body;

  // Se há informação sobre o último lead processado, atualiza seu status
  if (lastLead && lastPhone && progressStore.leads) {
    const leadIndex = progressStore.leads.findIndex(
      lead => lead.name === lastLead && lead.phone === lastPhone
    );

    if (leadIndex !== -1) {
      // Atualiza status do lead baseado no status geral
      // Se status é 'done' ou 'running', assumimos sucesso (pode ser ajustado conforme lógica do n8n)
      // Se precisar detectar erro, o n8n deve enviar status específico ou campo adicional
      if (status === 'done' || status === 'running') {
        progressStore.leads[leadIndex].status = 'success';
        progressStore.leads[leadIndex].sentAt = new Date().toISOString();
      }
      // Se o n8n enviar status 'error' no status geral, podemos marcar como erro
      // Mas geralmente cada lead terá seu próprio resultado
    }
  }

  // Atualiza o tempo para próximo envio se fornecido
  let tempoParaEnvioAtualizado = progressStore.tempoParaEnvio;
  let timestampRecebidoAtualizado = progressStore.timestampRecebido;
  
  if (tempoParaEnvio !== undefined && tempoParaEnvio !== null) {
    tempoParaEnvioAtualizado = parseInt(tempoParaEnvio);
    timestampRecebidoAtualizado = Date.now();
  }

  // Atualiza o store de progresso
  progressStore = {
    ...progressStore,
    campaignName: campaignName || progressStore.campaignName,
    sent: sent !== undefined ? parseInt(sent) : progressStore.sent,
    total: total !== undefined ? parseInt(total) : progressStore.total,
    status: status || progressStore.status,
    tempoParaEnvio: tempoParaEnvioAtualizado,
    timestampRecebido: timestampRecebidoAtualizado
  };

  // Faz broadcast para todos os clientes SSE
  broadcastProgress();

  return res.json({ message: 'Progresso atualizado' });
});

// GET /api/progress (PROTEGIDA)
app.get('/api/progress', authMiddleware, (req, res) => {
  return res.json(progressStore);
});

// POST /api/stop (PROTEGIDA) - Para o disparo
app.post('/api/stop', authMiddleware, async (req, res) => {
  try {
    if (progressStore.status !== 'running') {
      return res.status(400).json({ error: 'Nenhuma campanha em execução' });
    }

    // Atualiza status para stopped
    progressStore.status = 'stopped';

    // Marca leads pendentes como não enviados (mantém o status)
    if (progressStore.leads) {
      progressStore.leads.forEach(lead => {
        if (lead.status === 'pending') {
          lead.status = 'not_sent';
        }
      });
    }

    // Envia comando de stop para o n8n
    try {
      await axios.post(N8N_WEBHOOK_URL, {
        action: 'stop',
        campaignName: progressStore.campaignName
      });
    } catch (error) {
      console.error('Erro ao enviar stop para n8n:', error.message);
    }

    // Faz broadcast
    broadcastProgress();

    return res.json({ message: 'Disparo parado com sucesso' });
  } catch (error) {
    console.error('Erro ao parar disparo:', error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/reset (PROTEGIDA) - Reseta para nova campanha
app.post('/api/reset', authMiddleware, (req, res) => {
  progressStore = {
    total: 0,
    sent: 0,
    campaignName: '',
    status: 'idle',
    leads: [],
    tempoParaEnvio: null,
    timestampRecebido: null
  };

  broadcastProgress();

  return res.json({ message: 'Painel resetado para nova campanha' });
});

// GET /api/progress/stream (SSE - PROTEGIDA via query token)
app.get('/api/progress/stream', (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    // Valida o token
    jwt.verify(token, JWT_SECRET);

    // Configura headers para SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Envia progresso inicial
    res.write(`data: ${JSON.stringify(progressStore)}\n\n`);

    // Adiciona cliente à lista
    sseClients.add(res);

    // Remove cliente quando conexão é fechada
    req.on('close', () => {
      sseClients.delete(res);
    });
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

