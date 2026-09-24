import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAny, detectFormat } from './parsers.js';

test('nmap normal output', () => {
  const txt = `Starting Nmap 7.94
Nmap scan report for web.lab.local (10.10.10.5)
Host is up (0.012s latency).
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 8.9p1 Ubuntu 3ubuntu0.6
80/tcp   open  http    nginx 1.18.0
443/tcp  closed https
OS details: Linux 5.4 - 5.15

Nmap scan report for 10.10.10.6
Host is up.
3306/tcp open  mysql   MySQL 8.0.36`;
  assert.equal(detectFormat(txt), 'nmap');
  const r = parseAny(txt);
  assert.equal(r.hosts.length, 2);
  assert.deepEqual(r.hosts[0].ports.map((p) => p.port), [22, 80]);
  assert.equal(r.hosts[0].hostname, 'web.lab.local');
  assert.equal(r.hosts[0].ip, '10.10.10.5');
  assert.equal(r.hosts[0].os, 'Linux 5.4 - 5.15');
  assert.equal(r.hosts[0].ports[1].version, 'nginx 1.18.0');
  assert.equal(r.hosts[1].ip, '10.10.10.6');
});

test('nmap xml', () => {
  const xml = `<?xml version="1.0"?><nmaprun scanner="nmap"><host><status state="up"/>
<address addr="192.168.1.10" addrtype="ipv4"/><address addr="AA:BB" addrtype="mac"/>
<hostnames><hostname name="dc01.corp.local" type="PTR"/></hostnames>
<ports><port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds" product="Windows Server 2019"/></port>
<port protocol="tcp" portid="135"><state state="filtered"/></port>
<port protocol="udp" portid="53"><state state="open"/><service name="domain"/></port></ports>
<os><osmatch name="Microsoft Windows Server 2019" accuracy="95"/></os></host></nmaprun>`;
  assert.equal(detectFormat(xml), 'nmap-xml');
  const r = parseAny(xml);
  assert.equal(r.hosts.length, 1);
  assert.equal(r.hosts[0].ip, '192.168.1.10');
  assert.equal(r.hosts[0].hostname, 'dc01.corp.local');
  assert.equal(r.hosts[0].os, 'Microsoft Windows Server 2019');
  assert.deepEqual(r.hosts[0].ports.map((p) => `${p.port}/${p.proto}`), ['445/tcp', '53/udp']);
  assert.equal(r.hosts[0].ports[0].version, 'Windows Server 2019');
});

test('nmap grepable', () => {
  const g = `# Nmap 7.94 scan initiated
Host: 10.0.0.1 (gw)\tStatus: Up
Host: 10.0.0.1 (gw)\tPorts: 22/open/tcp//ssh//OpenSSH 9.2/, 80/open/tcp//http//nginx/, 8080/closed/tcp//http-proxy///\tIgnored State: filtered (997)`;
  assert.equal(detectFormat(g), 'nmap-grepable');
  const r = parseAny(g);
  assert.equal(r.hosts.length, 1);
  assert.deepEqual(r.hosts[0].ports.map((p) => p.port), [22, 80]);
  assert.equal(r.hosts[0].ports[0].version, 'OpenSSH 9.2');
});

test('gobuster dir and dns', () => {
  const txt = `===============================================================
[+] Url:                     http://10.10.10.5
[+] Wordlist:                common.txt
===============================================================
/admin                (Status: 301) [Size: 178] [--> /admin/]
/uploads              (Status: 200) [Size: 4523]
/robots.txt           (Status: 200) [Size: 26]
Found: dev.lab.local`;
  assert.equal(detectFormat(txt), 'gobuster');
  const r = parseAny(txt);
  assert.equal(r.paths.length, 3);
  assert.equal(r.paths[0].base, 'http://10.10.10.5');
  assert.deepEqual(r.paths.map((p) => p.status), [301, 200, 200]);
  assert.equal(r.hosts[0].hostname, 'dev.lab.local');
});

test('ffuf json and text', () => {
  const j = JSON.stringify({ config: { url: 'http://target/FUZZ' }, results: [
    { input: { FUZZ: 'api' }, status: 200, length: 120, words: 10, url: 'http://target/api' },
    { input: { FUZZ: 'login' }, status: 302, length: 0, words: 0, url: 'http://target/login' },
  ] });
  assert.equal(detectFormat(j), 'ffuf');
  const r = parseAny(j);
  assert.deepEqual(r.paths.map((p) => p.path), ['/api', '/login']);
  assert.equal(r.paths[0].base, 'http://target');
  const t = ` :: URL              : http://target/FUZZ
\x1b[2K.git                    [Status: 403, Size: 277, Words: 20, Lines: 10]
backup                  [Status: 200, Size: 1300, Words: 90, Lines: 30]`;
  assert.equal(detectFormat(t), 'ffuf');
  const r2 = parseAny(t);
  assert.deepEqual(r2.paths.map((p) => [p.path, p.status]), [['/.git', 403], ['/backup', 200]]);
});

test('dirb', () => {
  const t = `URL_BASE: http://10.10.10.5/
==> DIRECTORY: http://10.10.10.5/images/
+ http://10.10.10.5/index.php (CODE:200|SIZE:1234)`;
  assert.equal(detectFormat(t), 'dirb');
  const r = parseAny(t);
  assert.deepEqual(r.paths.map((p) => p.path), ['/images/', '/index.php']);
});

test('unknown input', () => {
  assert.equal(parseAny('hello world'), null);
});
