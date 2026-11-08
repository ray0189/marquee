from app.language import english_track, is_english


def test_english_releases_pass():
    assert is_english("The.Dark.Knight.2008.1080p.BluRay.x264-RARBG")  # untagged = English
    assert is_english("Avengers.Age.of.Ultron.2015.MULTi.2160p.UHD.BluRay")  # MULTi includes English
    assert is_english("Mstiteli.2015.RUS.ENG.2160p")  # says it has English
    assert is_english("The.Italian.Job.2003.1080p.BluRay", title="The Italian Job")  # title word, not a tag
    assert is_english("Chi-Raq.2015.1080p.WEB-DL", title="Chi-Raq")


def test_other_languages_are_dropped():
    assert not is_english("Мстители Эра Альтрона.2015.Hybrid.UHD.Blu-Ray.Remux.2160p")
    assert not is_english("Il Cavaliere oscuro (2008) WEBRip 1080p x264 ITA")
    assert not is_english("La tumba de las luciernagas Esp Jap lat 1080p LATINO")
    assert not is_english("Hotaru no Haka - Grobowiec swietlikow.1988.PL.BluRay")
    assert not is_english("Parasite.2019.KOREAN.2160p.BluRay")
    assert not is_english("Vingadores.Era.de.Ultron.2015.1080p.BluRay.DUBLADO")


def test_english_audio_track_is_found():
    assert english_track([{"language": "rus", "title": "Dub"}, {"language": "eng", "title": "Original"}]) == 1
    assert english_track([{"language": "en"}]) == 0
    assert english_track([{"language": "ita"}, {"language": "fre"}]) is None
