-- JML Projet Vendeur — schéma PostgreSQL canonique
-- Idempotent : ne supprime aucune table ni aucune donnée.
-- Application : psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- Les ventes DVF et DVF+ restent séparées pour éviter le double comptage.

BEGIN;

CREATE TABLE IF NOT EXISTS jml_prospects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  phone TEXT,
  email TEXT,
  property_type TEXT NOT NULL DEFAULT 'Maison',
  horizon TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'Autre',
  status TEXT NOT NULL DEFAULT 'À qualifier',
  contact_basis TEXT NOT NULL DEFAULT 'À vérifier',
  contact_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ,
  notes TEXT,
  score INTEGER,
  priority TEXT,
  reasons JSONB,
  next_action TEXT,
  next_action_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  contact_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_activities (
  id TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL REFERENCES jml_prospects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  note TEXT,
  outcome TEXT,
  appointment_at TIMESTAMPTZ,
  appointment_location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_appointment_requests (
  id TEXT PRIMARY KEY,
  prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  requested_location TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'À traiter',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_seller_spaces (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL UNIQUE,
  prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
  city TEXT,
  address TEXT,
  property_type TEXT,
  horizon TEXT,
  surface TEXT,
  rooms TEXT,
  dpe TEXT,
  terrain TEXT,
  owner_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_price TEXT,
  sale_reason TEXT,
  already_estimated BOOLEAN,
  already_professional BOOLEAN,
  estimator_agent_data JSONB,
  condition_data JSONB,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  property_type TEXT,
  horizon TEXT,
  source TEXT NOT NULL DEFAULT 'Lead Magnet',
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_seller_accounts (
  id TEXT PRIMARY KEY,
  seller_space_token TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  google_sub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jml_bpe_assets (
  id BIGSERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  commune_code TEXT NOT NULL,
  domain TEXT,
  subdomain TEXT,
  type_code TEXT,
  type_label TEXT,
  name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  address TEXT,
  source TEXT NOT NULL DEFAULT 'INSEE BPE 2025',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(year, commune_code, type_code, name, latitude, longitude)
);

CREATE TABLE IF NOT EXISTS jml_dvf_sales (
  id BIGSERIAL PRIMARY KEY,
  mutation_id TEXT NOT NULL,
  sale_date DATE,
  property_type TEXT NOT NULL,
  price NUMERIC NOT NULL CHECK (price > 0),
  surface NUMERIC NOT NULL CHECK (surface > 0),
  rooms NUMERIC,
  land_surface NUMERIC,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  address TEXT,
  street TEXT,
  postal_code TEXT,
  commune_code TEXT,
  commune_name TEXT,
  parcel_id TEXT,
  source_year INTEGER NOT NULL,
  price_per_m2 NUMERIC NOT NULL CHECK (price_per_m2 > 0),
  source TEXT NOT NULL DEFAULT 'DVF',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_year, mutation_id, property_type, price, surface, address, parcel_id)
);

CREATE TABLE IF NOT EXISTS jml_dvfplus_sales (
  id BIGSERIAL PRIMARY KEY,
  mutation_id TEXT NOT NULL,
  sale_date DATE,
  source_year INTEGER NOT NULL,
  property_type TEXT NOT NULL CHECK (property_type IN ('Maison','Appartement')),
  price NUMERIC NOT NULL CHECK (price > 0),
  surface NUMERIC NOT NULL CHECK (surface > 0),
  price_per_m2 NUMERIC NOT NULL CHECK (price_per_m2 > 0),
  rooms NUMERIC,
  land_surface NUMERIC,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  commune_code TEXT,
  parcel_ids TEXT,
  comparable_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  exclusion_reason TEXT,
  source TEXT NOT NULL DEFAULT 'DVF+ Cerema',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mutation_id, source_year)
);

CREATE TABLE IF NOT EXISTS jml_dpe (
  numero_dpe TEXT PRIMARY KEY,
  dpe TEXT NOT NULL,
  ges TEXT,
  dpe_date DATE,
  address TEXT,
  number_text TEXT,
  street TEXT,
  city TEXT,
  postal_code TEXT,
  department_code TEXT NOT NULL,
  city_code TEXT,
  surface_habitable NUMERIC,
  ban_x DOUBLE PRECISION,
  ban_y DOUBLE PRECISION,
  address_norm TEXT,
  street_norm TEXT,
  number_norm TEXT,
  energy_consumption NUMERIC,
  ghg_emissions NUMERIC,
  heating_type TEXT,
  property_type TEXT,
  construction_year INTEGER,
  source_updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un bien est une entité indépendante d'un contact/adresse :
-- plusieurs appartements peuvent partager la même adresse.
CREATE TABLE IF NOT EXISTS jml_properties (
  id TEXT PRIMARY KEY,
  prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
  seller_space_id TEXT REFERENCES jml_seller_spaces(id) ON DELETE SET NULL,
  property_type TEXT NOT NULL,
  address TEXT,
  address_norm TEXT,
  postal_code TEXT,
  commune_code TEXT,
  commune_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  habitable_surface NUMERIC,
  built_surface NUMERIC,
  land_surface NUMERIC,
  rooms NUMERIC,
  dpe TEXT,
  ges TEXT,
  cadastral_parcel_id TEXT,
  source TEXT NOT NULL DEFAULT 'JML',
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Annonces = prix affichés, jamais confondus avec des ventes DVF signées.
CREATE TABLE IF NOT EXISTS jml_property_listings (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_listing_id TEXT,
  source_url TEXT NOT NULL,
  title TEXT,
  property_type TEXT,
  listing_status TEXT NOT NULL DEFAULT 'active',
  price NUMERIC,
  habitable_surface NUMERIC,
  built_surface NUMERIC,
  land_surface NUMERIC,
  rooms NUMERIC,
  bedrooms NUMERIC,
  address TEXT,
  address_norm TEXT,
  postal_code TEXT,
  commune_code TEXT,
  commune_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  description TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_confidence NUMERIC CHECK (extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1),
  content_hash TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source, source_listing_id)
);

CREATE TABLE IF NOT EXISTS jml_import_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  dataset_version TEXT,
  department_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  rows_seen BIGINT NOT NULL DEFAULT 0,
  rows_inserted BIGINT NOT NULL DEFAULT 0,
  rows_updated BIGINT NOT NULL DEFAULT 0,
  rows_rejected BIGINT NOT NULL DEFAULT 0,
  error_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS jml_estimation_runs (
  id BIGSERIAL PRIMARY KEY,
  property_id TEXT REFERENCES jml_properties(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  algorithm_version TEXT NOT NULL,
  department_code TEXT,
  property_type TEXT,
  input_features JSONB NOT NULL,
  result JSONB NOT NULL,
  comparable_count INTEGER NOT NULL DEFAULT 0,
  reliability TEXT,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_jml_bpe_commune ON jml_bpe_assets(commune_code);
CREATE INDEX IF NOT EXISTS idx_jml_bpe_geo ON jml_bpe_assets(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_jml_dvf_geo_date ON jml_dvf_sales(latitude, longitude, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_dvf_type_geo_date ON jml_dvf_sales(property_type, latitude, longitude, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_dvf_commune_type_date ON jml_dvf_sales(commune_code, property_type, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_geo_date ON jml_dvfplus_sales(latitude, longitude, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_type_surface ON jml_dvfplus_sales(property_type, surface);
CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_commune_date ON jml_dvfplus_sales(commune_code, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_dpe_address ON jml_dpe(postal_code, street_norm, number_norm);
CREATE INDEX IF NOT EXISTS idx_jml_dpe_city ON jml_dpe(department_code, city_code);
CREATE INDEX IF NOT EXISTS idx_jml_dpe_date ON jml_dpe(dpe_date DESC);
CREATE INDEX IF NOT EXISTS idx_jml_prospects_updated ON jml_prospects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_prospects_status ON jml_prospects(status);
CREATE INDEX IF NOT EXISTS idx_jml_prospects_next_action ON jml_prospects(next_action_at);
CREATE INDEX IF NOT EXISTS idx_jml_activities_prospect ON jml_activities(prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_leads_created ON jml_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_prospect ON jml_seller_spaces(prospect_id);
CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_updated ON jml_seller_spaces(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_prospects_phone ON jml_prospects(phone);
CREATE INDEX IF NOT EXISTS idx_jml_prospects_email_lower ON jml_prospects(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_jml_seller_accounts_google_sub ON jml_seller_accounts(google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jml_properties_commune_type ON jml_properties(commune_code, property_type);
CREATE INDEX IF NOT EXISTS idx_jml_properties_geo ON jml_properties(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_jml_listings_source_status ON jml_property_listings(source, listing_status);
CREATE INDEX IF NOT EXISTS idx_jml_listings_commune_type ON jml_property_listings(commune_code, property_type);
CREATE INDEX IF NOT EXISTS idx_jml_listings_geo_seen ON jml_property_listings(latitude, longitude, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_import_runs_source_started ON jml_import_runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jml_estimation_runs_property_created ON jml_estimation_runs(property_id, created_at DESC);

COMMIT;
