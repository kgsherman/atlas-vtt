// Generated from the atlas-vtt Supabase project (supabase gen types / MCP generate_typescript_types).
// Do not edit by hand: regenerate after changing supabase/migrations. Note that Postgres function
// results are reported as non-null even where the SQL can return NULL (e.g. set_scene_visibility
// returns NULL when a scene goes private; session_info's member columns are NULL for the DM) —
// the typed wrappers in scenesRepo.ts / sessionsRepo.ts account for that.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      player_views: {
        Row: {
          epoch: string
          host_epoch: number
          seq: number
          session_id: string
          updated_at: string
          user_id: string
          view: Json
        }
        Insert: {
          epoch: string
          host_epoch: number
          seq: number
          session_id: string
          updated_at?: string
          user_id: string
          view: Json
        }
        Update: {
          epoch?: string
          host_epoch?: number
          seq?: number
          session_id?: string
          updated_at?: string
          user_id?: string
          view?: Json
        }
        Relationships: [
          {
            foreignKeyName: "player_views_session_id_user_id_fkey"
            columns: ["session_id", "user_id"]
            isOneToOne: true
            referencedRelation: "session_members"
            referencedColumns: ["session_id", "user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      scene_versions: {
        Row: {
          created_at: string
          data: Json
          scene_id: string
          schema_version: number
          version: number
        }
        Insert: {
          created_at?: string
          data: Json
          scene_id: string
          schema_version: number
          version: number
        }
        Update: {
          created_at?: string
          data?: Json
          scene_id?: string
          schema_version?: number
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "scene_versions_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      scenes: {
        Row: {
          created_at: string
          id: string
          latest_version: number
          name: string
          owner_id: string
          share_slug: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          created_at?: string
          id?: string
          latest_version?: number
          name: string
          owner_id: string
          share_slug?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          created_at?: string
          id?: string
          latest_version?: number
          name?: string
          owner_id?: string
          share_slug?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      session_members: {
        Row: {
          display_name: string
          joined_at: string
          session_id: string
          status: string
          user_id: string
        }
        Insert: {
          display_name: string
          joined_at?: string
          session_id: string
          status?: string
          user_id: string
        }
        Update: {
          display_name?: string
          joined_at?: string
          session_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_members_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_state: {
        Row: {
          epoch: number
          session_id: string
          state: Json
          updated_at: string
        }
        Insert: {
          epoch?: number
          session_id: string
          state: Json
          updated_at?: string
        }
        Update: {
          epoch?: number
          session_id?: string
          state?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_state_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          created_at: string
          dm_id: string
          ended_at: string | null
          host_epoch: number
          id: string
          room_code: string
          scene_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          dm_id: string
          ended_at?: string | null
          host_epoch?: number
          id?: string
          room_code: string
          scene_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          dm_id?: string
          ended_at?: string | null
          host_epoch?: number
          id?: string
          room_code?: string
          scene_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      begin_guest_merge: {
        Args: { p_target: string; p_token: string }
        Returns: Json
      }
      claim_host: { Args: { p_session_id: string }; Returns: number }
      create_merge_ticket: { Args: never; Returns: string }
      create_scene: {
        Args: { p_data: Json; p_name: string; p_schema_version: number }
        Returns: string
      }
      create_session: {
        Args: { p_scene_id: string }
        Returns: {
          room_code: string
          session_id: string
        }[]
      }
      end_session: { Args: { p_session_id: string }; Returns: boolean }
      finish_guest_merge: {
        Args: { p_target: string; p_token: string }
        Returns: Json
      }
      get_shared_scene: {
        Args: { p_slug: string }
        Returns: {
          data: Json
          name: string
          schema_version: number
          version: number
        }[]
      }
      image_folders_to_free: { Args: { p_scene_id: string }; Returns: string[] }
      join_session: {
        Args: { p_display_name: string; p_room_code: string }
        Returns: string
      }
      list_session_members: {
        Args: { p_session_id: string }
        Returns: {
          display_name: string
          joined_at: string
          status: string
          user_id: string
        }[]
      }
      save_scene_version: {
        Args: {
          p_base_version?: number
          p_data: Json
          p_name?: string
          p_scene_id: string
          p_schema_version: number
        }
        Returns: number
      }
      save_session_state: {
        Args: { p_epoch: number; p_session_id: string; p_state: Json }
        Returns: boolean
      }
      session_info: {
        Args: { p_session_id: string }
        Returns: {
          created_at: string
          display_name: string
          dm_display_name: string
          member_status: string
          role: string
          room_code: string
          session_id: string
          status: string
        }[]
      }
      set_display_name: { Args: { p_display_name: string }; Returns: string }
      set_member_status: {
        Args: { p_session_id: string; p_status: string; p_user_id: string }
        Returns: boolean
      }
      set_scene_visibility: {
        Args: { p_rotate?: boolean; p_scene_id: string; p_visibility: string }
        Returns: string
      }
      unreferenced_scene_assets: {
        Args: { p_min_age?: string }
        Returns: string[]
      }
      upsert_player_view: {
        Args: {
          p_epoch: string
          p_host_epoch: number
          p_seq: number
          p_session_id: string
          p_user_id: string
          p_view: Json
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
