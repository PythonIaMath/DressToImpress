import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

type AuthScreenProps = {
  onAuthenticated: (session: Session, user: User) => void;
};

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [loading, setLoading] = useState(false);

  const handleAuth = async () => {
    if (!email || !password) {
      Alert.alert('Champs requis', 'Merci de remplir email et mot de passe.');
      return;
    }

    try {
      setLoading(true);

      if (mode === 'signin') {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          throw error;
        }
        if (data.session && data.user) {
          onAuthenticated(data.session, data.user);
        }
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
          throw error;
        }
        if (data.user) {
          const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
            email,
            password,
          });
          if (signInError) {
            throw signInError;
          }
          if (signInData.session && signInData.user) {
            onAuthenticated(signInData.session, signInData.user);
          }
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Une erreur est survenue lors de l'authentification.";
      Alert.alert('Erreur', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.select({ ios: 'padding', android: undefined })}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>DressToImpress</Text>
        <Text style={styles.subtitle}>
          {mode === 'signin' ? 'Connecte-toi pour rejoindre ton lobby.' : 'Crée un compte pour jouer.'}
        </Text>

        <TextInput
          placeholder="Email"
          value={email}
          autoCapitalize="none"
          keyboardType="email-address"
          onChangeText={setEmail}
          style={styles.input}
        />
        <TextInput
          placeholder="Mot de passe"
          value={password}
          secureTextEntry
          onChangeText={setPassword}
          style={styles.input}
        />

        <View style={styles.buttons}>
          <Button title={loading ? '...' : mode === 'signin' ? 'Se connecter' : "S'inscrire"} onPress={handleAuth} disabled={loading} />
        </View>

        <Button
          title={
            mode === 'signin'
              ? "Pas de compte ? Créez-en un."
              : 'Déjà un compte ? Connectez-vous.'
          }
          onPress={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
          disabled={loading}
        />

        {loading && (
          <View style={styles.loading}>
            <ActivityIndicator />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    padding: 24,
  },
  inner: {
    backgroundColor: '#ffffff',
    padding: 24,
    borderRadius: 16,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1e293b',
  },
  subtitle: {
    fontSize: 16,
    color: '#475569',
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5f5',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  buttons: {
    gap: 12,
  },
  loading: {
    alignItems: 'center',
  },
});
