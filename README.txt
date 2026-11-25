====================================================================
              AUSEC KICK YAYIN PAKETİ - KURULUM REHBERİ
====================================================================

Bu paket 3 canlı yayın eklentisini tek bir servis altında çalıştırır:
1) Halay & Orkestra (@Ausec, @anildegil, @Elfsec)
2) Topik Bilye Yarışı (6 farklı uzun harita)
3) 100 AUSEC Para Yağmuru (Abone, Hediye, KICKs, Bağış, Takip)

--------------------------------------------------------------------
1. İLK KURULUM (SADECE BİR KEZ)
--------------------------------------------------------------------
1) Bilgisayarda Node.js kurulu değilse https://nodejs.org adresinden
   "LTS" sürümünü indirip kurun.
2) Bu klasördeki "baslat.bat" dosyasına çift tıklayın.
   İlk açılışta gerekli paket otomatik kurulur ve servis açılır.
3) Tarayıcıdan http://localhost:8787 adresine girin.
   Buradan hem bağlantıyı görebilir hem de tek tıkla test edebilirsiniz.

--------------------------------------------------------------------
2. OBS STUDIO EKLEME (BİR KEZ YAPILIR)
--------------------------------------------------------------------
Her biri için: OBS -> Kaynaklar -> "+" -> Tarayıcı (Browser)
("Yerel Dosya" kutusunu İŞARETLEMEYİN, doğrudan URL yazın)

- HALAY & ORKESTRA:
  URL     : http://localhost:8787/halay?temiz=1
  Boyut   : Genişlik 500 | Yükseklik 230

- TOPİK YARIŞI:
  URL     : http://localhost:8787/topik
  Boyut   : Genişlik 420 | Yükseklik 720

- 100 AUSEC PARA YAĞMURU (Sahnede EN ÜSTE koyun):
  URL     : http://localhost:8787/para?ses=1
  Boyut   : Genişlik 1920 | Yükseklik 1080

--------------------------------------------------------------------
3. HER YAYINDAN ÖNCE
--------------------------------------------------------------------
Sadece "baslat.bat" dosyasına çift tıklayıp siyah pencereyi
simge durumuna küçültmeniz yeterlidir.

--------------------------------------------------------------------
4. GÜNCELLEME ALMA
--------------------------------------------------------------------
Yeni özellik veya düzeltme geldiğinde "guncelle.bat" dosyasına çift
tıklayın veya http://localhost:8787 panelinden "Güncellemeleri Yükle"
butonuna basın. Kanal ayarlarınız bozulmadan dosyalar yenilenir.

--------------------------------------------------------------------
5. SOHBET KOMUTLARI
--------------------------------------------------------------------
Halay:
  !halay, !hizlan, !yavas, !zeybek, !mendil (rozetliler)
Topik:
  !topik (katıl), !başlat (sadece yayıncı/mod)
Para Yağmuru (sadece yayıncı/mod, gerçek olaylar zaten otomatiktir):
  !abone <isim>, !hediye <isim> <adet>, !para <isim> <tutar>,
  !kicks <isim> <adet>, !takip <isim>, !testpara
====================================================================