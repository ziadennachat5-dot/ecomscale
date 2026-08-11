import { useState, useEffect, useRef } from "react";
import { Search, MapPin, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { ShippingCarrier } from "../lib/types";

export interface OzonCity {
  id: number;
  ref: string;
  name: string;
  delivered_price: number;
  returned_price: number;
  refused_price: number;
}

export interface ColiatyCity {
  id: number;
  name: string;
}

export interface ForceLogCity {
  provider_city_id: number;
  code: string;
  name: string;
  delivered_price: number | null;
  same_city_price: number | null;
}

export interface CitySelectorValue {
  ozon_city_id?: number | null;
  carrier_city_id?: number | null;
  city_name: string;
}

interface CitySelectorProps {
  value: CitySelectorValue;
  onChange: (value: CitySelectorValue) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  showWarning?: boolean;
  carrier?: ShippingCarrier;
}

export function CitySelector({
  value,
  onChange,
  placeholder = "Search city...",
  required = false,
  disabled = false,
  showWarning = false,
  carrier = 'ozon',
}: CitySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<Array<OzonCity | ColiatyCity | ForceLogCity>>([]);
  const [loading, setLoading] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const tableName = carrier === 'forcelog' ? 'forcelog_cities' : carrier === 'coliaty' ? 'coliaty_cities' : 'ozon_cities';
  const hasCityId = carrier === 'ozon' ? value.ozon_city_id : value.carrier_city_id;

  // Load default cities on focus if empty
  useEffect(() => {
    if (isOpen && searchQuery.trim().length === 0 && results.length === 0) {
      loadDefaultCities();
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim().length >= 2) {
        searchCities(searchQuery);
      } else if (searchQuery.trim().length === 0) {
        // Show default cities when cleared
        loadDefaultCities();
      } else {
        setResults([]);
        setNoResults(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadDefaultCities = async () => {
    setLoading(true);
    setNoResults(false);

    try {
      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .order("name")
        .limit(50);

      if (error) throw error;

      setResults(data || []);
      setNoResults((data || []).length === 0);
    } catch (error) {
      console.error("Error loading default cities:", error);
      setResults([]);
      setNoResults(true);
    } finally {
      setLoading(false);
    }
  };

  const searchCities = async (query: string) => {
    setLoading(true);
    setNoResults(false);

    try {
      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .ilike("name", `%${query}%`)
        .order("name")
        .limit(20);

      if (error) throw error;

      setResults(data || []);
      setNoResults((data || []).length === 0);
    } catch (error) {
      console.error("Error searching cities:", error);
      setResults([]);
      setNoResults(true);
    } finally {
      setLoading(false);
    }
  };

  const saveToCityArabicNames = async (arabicName: string, carrierCityId: number) => {
    if (carrier === 'ozon') return;
    
    try {
      // Check if mapping already exists
      const { data: existing } = await supabase
        .from('city_arabic_names')
        .select('*')
        .eq('carrier', carrier)
        .eq('arabic_name', arabicName)
        .single();

      if (!existing) {
        // Insert new mapping
        await supabase
          .from('city_arabic_names')
          .insert({
            carrier,
            arabic_name: arabicName,
            carrier_city_id: carrierCityId,
            ozon_city_id: null
          });
        console.log(`Saved ${carrier} mapping: "${arabicName}" -> ${carrierCityId}`);
      }
    } catch (error) {
      console.error("Error saving city mapping:", error);
    }
  };

  const handleSelectCity = (city: OzonCity | ColiatyCity | ForceLogCity) => {
    const newValue: CitySelectorValue = {
      city_name: city.name,
    };

    if (carrier !== 'ozon') {
      const providerCityId = 'provider_city_id' in city ? city.provider_city_id : city.id;
      newValue.carrier_city_id = providerCityId;
      newValue.ozon_city_id = null;
      // Save mapping for future automatic resolution
      if (value.city_name) {
        saveToCityArabicNames(value.city_name, city.id);
      }
    } else {
      newValue.ozon_city_id = city.id;
      newValue.carrier_city_id = null;
    }

    onChange(newValue);
    setSearchQuery("");
    setIsOpen(false);
    setResults([]);
  };

  const handleClear = () => {
    const newValue: CitySelectorValue = {
      city_name: "",
      ozon_city_id: null,
      carrier_city_id: null,
    };
    onChange(newValue);
    setSearchQuery("");
  };

  const displayValue = value.city_name || searchQuery;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
          <MapPin size={16} />
        </div>
        <input
          type="text"
          value={displayValue}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setIsOpen(true);
            // Clear selection when user starts typing
            if (hasCityId) {
              const newValue: CitySelectorValue = {
                city_name: e.target.value,
                ozon_city_id: null,
                carrier_city_id: null,
              };
              onChange(newValue);
            }
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className={`w-full rounded-lg border border-base-border bg-base-raised pl-10 pr-10 py-2 text-[13px] text-ink focus:border-brand-accent/50 focus:outline-none disabled:opacity-60 ${
            showWarning && !hasCityId ? "border-warn/50 bg-warn/5" : ""
          }`}
        />
        {displayValue && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
          >
            <span className="text-[14px]">×</span>
          </button>
        )}
      </div>

      {showWarning && !hasCityId && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-warn">
          <AlertCircle size={12} />
          <span>City to verify - please select from dropdown</span>
        </div>
      )}

      {isOpen && (results.length > 0 || loading || noResults) && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-base-border bg-base-surface shadow-lg">
          {loading && (
            <div className="flex items-center justify-center py-4 text-[12px] text-ink-muted">
              Searching...
            </div>
          )}

          {!loading && noResults && (
            <div className="flex items-center justify-center py-4 text-[12px] text-ink-muted">
              No cities found
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="py-1">
              {results.map((city) => (
                <button
                  key={city.id}
                  type="button"
                  onClick={() => handleSelectCity(city)}
                  className="w-full px-3 py-2 text-left text-[13px] text-ink hover:bg-brand-accent/10 focus:bg-brand-accent/10 focus:outline-none"
                >
                  <div className="font-medium">{city.name}</div>
                  {carrier === 'ozon' && 'ref' in city && (
                    <div className="text-[11px] text-ink-muted">
                      {(city as OzonCity).ref} • Delivery: {(city as OzonCity).delivered_price} DH
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
