// Rails: routes.rb endpoints and Zeitwerk constant resolution.
// Rails autoloads, so almost nothing is `require`d: the links between files are constant
// references, and the endpoints live in one routes.rb rather than beside their handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run, readGraph } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { createResolver } = await lib('resolve.mjs');

const routesOf = (src) => extract(src, 'ruby', 'config/routes.rb').routes;
const sigs = (src) => routesOf(src).map((r) => `${r.method} ${r.path}`);
const draw = (body) => `Rails.application.routes.draw do\n${body}\nend\n`;

// ---------- routes.rb ----------

test('Rails: a plural resource is its seven endpoints', () => {
  assert.deepEqual(sigs(draw(`  resources :companies`)), [
    'GET /companies',
    'POST /companies',
    'GET /companies/new',
    'GET /companies/:id/edit',
    'GET /companies/:id',
    'PATCH /companies/:id',
    'PUT /companies/:id',
    'DELETE /companies/:id',
  ]);
});

test('Rails: only: and except: narrow the endpoints', () => {
  assert.deepEqual(sigs(draw(`  resources :companies, only: %i[index show]`)), [
    'GET /companies',
    'GET /companies/:id',
  ]);
  assert.deepEqual(sigs(draw(`  resources :errors, except: %i[destroy edit new create update]`)), [
    'GET /errors',
    'GET /errors/:id',
  ]);
  assert.deepEqual(sigs(draw(`  resources :job_runs, only: :index`)), ['GET /job_runs']);
});

test('Rails: a singular resource has no index and no :id', () => {
  // `rails routes` order for a singular resource: create, new, edit, show, update, destroy.
  assert.deepEqual(sigs(draw(`  resource :session, only: %i[show create destroy]`)), [
    'POST /session',
    'GET /session',
    'DELETE /session',
  ]);
});

test('Rails: member and collection blocks hang off the resource', () => {
  assert.deepEqual(sigs(draw([
    `  resources :errors, only: :index do`,
    `    member do`,
    `      post :requeue`,
    `    end`,
    `    collection do`,
    `      post :bulk_requeue`,
    `    end`,
    `  end`,
  ].join('\n'))), [
    'GET /errors',
    'POST /errors/:id/requeue',
    'POST /errors/bulk_requeue',
  ]);
});

test('Rails: namespace adds a path segment and a controller module', () => {
  const r = routesOf(draw([
    `  namespace :api do`,
    `    namespace :v1 do`,
    `      get 'status' => 'status#show'`,
    `    end`,
    `  end`,
  ].join('\n')));
  assert.deepEqual(r.map((x) => `${x.method} ${x.path}`), ['GET /api/v1/status']);
  assert.equal(r[0].controller, 'api/v1/status');
  assert.equal(r[0].action, 'show');
});

test('Rails: namespace path: renames the URL but keeps the module', () => {
  const r = routesOf(draw([
    `  namespace :accounts_receivable, path: 'ar' do`,
    `    resource :exports, only: :show, controller: 'exports'`,
    `  end`,
  ].join('\n')));
  assert.deepEqual(r.map((x) => `${x.method} ${x.path}`), ['GET /ar/exports']);
  assert.equal(r[0].controller, 'accounts_receivable/exports');
});

test('Rails: scope path: moves the URL without touching the controller', () => {
  const r = routesOf(draw([
    `  scope path: '/ap' do`,
    `    resources :inbound_records, only: :show`,
    `  end`,
  ].join('\n')));
  assert.deepEqual(r.map((x) => `${x.method} ${x.path}`), ['GET /ap/inbound_records/:id']);
  assert.equal(r[0].controller, 'inbound_records');
});

test('Rails: both arrow and to: spellings name a controller and action', () => {
  const a = routesOf(draw(`  get 'healthz' => 'healthz#show', as: :healthz`))[0];
  assert.equal(a.path, '/healthz');
  assert.equal(a.controller, 'healthz');
  assert.equal(a.action, 'show');
  const b = routesOf(draw(`  get 'sign_in', to: 'users/sessions#new'`))[0];
  assert.equal(b.path, '/sign_in');
  assert.equal(b.controller, 'users/sessions');
  assert.equal(b.action, 'new');
});

test('Rails: root is the home page', () => {
  const r = routesOf(draw(`  root 'home#index'`))[0];
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/');
  assert.equal(r.controller, 'home');
  assert.equal(r.action, 'index');
});

test('Rails: a verb inside a singular resource hangs off it, with action:', () => {
  const r = routesOf(draw([
    `  resource :payments, only: :show, controller: 'payments' do`,
    `    post :retrieve`,
    `    get 'files/:job_run_file_id/download', action: :download, as: :download`,
    `  end`,
  ].join('\n')));
  assert.deepEqual(r.map((x) => `${x.method} ${x.path}`), [
    'GET /payments',
    'POST /payments/retrieve',
    'GET /payments/files/:job_run_file_id/download',
  ]);
  assert.equal(r[2].action, 'download');
  assert.equal(r[2].controller, 'payments');
});

test('Rails: nested resources sit under the parent id', () => {
  assert.deepEqual(sigs(draw([
    `  resources :ramp_configurations, only: :show do`,
    `    resources :member_companies, only: :new, controller: 'ramp_configuration_member_companies'`,
    `  end`,
  ].join('\n'))), [
    'GET /ramp_configurations/:id',
    'GET /ramp_configurations/:ramp_configuration_id/member_companies/new',
  ]);
});

test('Rails: shallow nesting lifts the member endpoints out of the parent', () => {
  assert.deepEqual(sigs(draw([
    `  resources :agris_instances, only: :show do`,
    `    resources :agris_tenants, shallow: true, only: %i[index show] do`,
    `      member do`,
    `        put :verify`,
    `      end`,
    `    end`,
    `  end`,
  ].join('\n'))), [
    'GET /agris_instances/:id',
    'GET /agris_instances/:agris_instance_id/agris_tenants',
    'GET /agris_tenants/:id',
    'PUT /agris_tenants/:id/verify',
  ]);
});

test('Rails: a redirect is an endpoint too, just not one a controller serves', () => {
  const r = routesOf(draw(`  get '/ar', to: redirect('/ar/exports')`));
  assert.deepEqual(r.map((x) => `${x.method} ${x.path}`), ['GET /ar']);
  assert.equal(r[0].controller, null);
});

test('Rails: routes.rb is the only Ruby file read for endpoints', () => {
  assert.deepEqual(extract(`get 'x' => 'y#z'\n`, 'ruby', 'app/models/thing.rb').routes, []);
});

// ---------- Zeitwerk ----------

test('Zeitwerk: a constant reference resolves to the file whose path camelizes to it', () => {
  const files = [
    { path: 'app/services/agris/export_disbursement.rb', lang: 'ruby', repo: '.' },
    { path: 'app/models/company.rb', lang: 'ruby', repo: '.' },
    { path: 'lib/agris_services/client.rb', lang: 'ruby', repo: '.' },
  ];
  const root = makeProject(Object.fromEntries(files.map((f) => [f.path, ''])));
  const resolve = createResolver(root, files);
  const from = files[0];
  assert.equal(resolve(from, { spec: 'Company', kind: 'const' }).file, 'app/models/company.rb');
  assert.equal(resolve(from, { spec: 'AgrisServices::Client', kind: 'const' }).file, 'lib/agris_services/client.rb');
});

test('Zeitwerk: a bare constant prefers the referencing file own namespace', () => {
  const files = [
    { path: 'app/services/agris/export_disbursement.rb', lang: 'ruby', repo: '.' },
    { path: 'app/services/agris/client.rb', lang: 'ruby', repo: '.' },
    { path: 'app/models/client.rb', lang: 'ruby', repo: '.' },
    { path: 'app/models/invoice.rb', lang: 'ruby', repo: '.' },
  ];
  const root = makeProject(Object.fromEntries(files.map((f) => [f.path, ''])));
  const resolve = createResolver(root, files);
  // Inside module Agris, `Client` is Agris::Client; from the top level it is the plain one.
  assert.equal(resolve(files[0], { spec: 'Client', kind: 'const' }).file, 'app/services/agris/client.rb');
  assert.equal(resolve(files[3], { spec: 'Client', kind: 'const' }).file, 'app/models/client.rb');
});

test('Zeitwerk: a constant that is not ours is not an external package', () => {
  const files = [{ path: 'app/models/company.rb', lang: 'ruby', repo: '.' }];
  const root = makeProject({ 'app/models/company.rb': '' });
  const resolve = createResolver(root, files);
  for (const spec of ['String', 'ActiveRecord::Base', 'Rails']) {
    const r = resolve(files[0], { spec, kind: 'const' });
    assert.equal(r.file, undefined, `${spec} should not resolve to a file`);
    assert.equal(r.external, undefined, `${spec} should not become a package`);
  }
});

test('Ruby: constant references are collected, declarations and noise are not', () => {
  const r = extract([
    `module Agris`,
    `  class ExportDisbursement`,
    `    def call`,
    `      Company.find(id)        # a real reference`,
    `      logger.info "Voucher::X" # inside a string, not code`,
    `      CONSTANT_CASE`,
    `    end`,
    `  end`,
    `end`,
  ].join('\n'), 'ruby', 'app/services/agris/export_disbursement.rb');
  const specs = r.imports.map((i) => i.spec);
  assert.ok(specs.includes('Company'), 'Company is referenced');
  assert.ok(!specs.includes('ExportDisbursement'), 'its own declaration is not a reference');
  assert.ok(!specs.includes('Agris'), 'its own namespace is not a reference');
  assert.ok(!specs.includes('Voucher::X'), 'strings are not code');
  assert.ok(!specs.includes('CONSTANT_CASE'), 'SCREAMING_CASE is a value, not a class');
});

test('Ruby: require_relative still resolves', () => {
  const r = extract(`require_relative 'support/thing'\n`, 'ruby', 'lib/tasks/run.rb');
  assert.deepEqual(r.imports.map((i) => i.spec), ['./support/thing']);
});

// ---------- end to end ----------

test('a Rails app gets edges between its files and endpoints on its controllers', () => {
  const root = makeProject({
    'Gemfile': `source 'https://rubygems.org'\ngem 'rails'\n`,
    'config/routes.rb': draw([
      `  resources :companies, only: %i[index show]`,
      `  root 'home#index'`,
    ].join('\n')),
    'app/controllers/companies_controller.rb': [
      `class CompaniesController < ApplicationController`,
      `  def index`,
      `    @companies = Company.all`,
      `    ExportBatch.pending`,
      `  end`,
      `end`,
    ].join('\n'),
    'app/controllers/home_controller.rb': `class HomeController < ApplicationController\n  def index; end\nend\n`,
    'app/models/company.rb': `class Company < ApplicationRecord\nend\n`,
    'app/models/export_batch.rb': `class ExportBatch < ApplicationRecord\nend\n`,
  }, { repos: ['.'] });

  const out = run('scan.mjs', root);
  const scan = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));

  const routes = scan.routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(routes.includes('GET /companies'), `expected GET /companies in ${routes.join(', ')}`);
  assert.ok(routes.includes('GET /'), 'root is an endpoint');

  const index = scan.routes.find((r) => r.path === '/companies');
  assert.equal(index.file, 'app/controllers/companies_controller.rb',
    'an endpoint belongs to its controller, not to routes.rb');

  const edges = scan.edges
    .filter((e) => e.from === 'app/controllers/companies_controller.rb')
    .map((e) => e.to);
  assert.ok(edges.includes('app/models/company.rb'), `expected a Company edge, got ${edges.join(', ')}`);
  assert.ok(edges.includes('app/models/export_batch.rb'), 'ExportBatch is an edge too');

  // ApplicationController and ApplicationRecord are Rails, not packages this app depends on.
  assert.deepEqual(scan.externals, []);
  assert.match(out, /ruby/);
});
